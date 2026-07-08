// src/exclusive_audio.cc
#include <napi.h>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstdint>

#if defined(_WIN32) && !defined(EXCLUSIVE_WIN32)
#define EXCLUSIVE_WIN32
#endif
#if defined(__APPLE__) && !defined(EXCLUSIVE_MACOS)
#define EXCLUSIVE_MACOS
#endif
#if defined(__linux__) && !defined(EXCLUSIVE_LINUX)
#define EXCLUSIVE_LINUX
#endif

#if defined(EXCLUSIVE_WIN32)
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <mmreg.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "avrt.lib")
#ifndef DBG
#include <cstdio>
#define DBG(msg)                      \
    do                                \
    {                                 \
        printf("[native] %s\n", msg); \
        fflush(stdout);               \
    } while (0)
#endif
#endif

#if defined(EXCLUSIVE_MACOS)
#include <AudioToolbox/AudioToolbox.h>
#include <AudioUnit/AudioUnit.h>
#include <CoreAudio/CoreAudio.h>
#include <CoreServices/CoreServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <unistd.h>
#endif

#if defined(EXCLUSIVE_LINUX)
#include <alsa/asoundlib.h>
#include <poll.h>
#include <unistd.h>
#include <fcntl.h>
#endif

// Provide a lightweight debug macro on non-Windows platforms
#ifndef DBG
#include <cstdio>
#define DBG(msg)                               \
    do                                         \
    {                                          \
        fprintf(stderr, "[native] %s\n", msg); \
        fflush(stderr);                        \
    } while (0)
#endif

struct OutputStreamState;

static std::map<uint32_t, OutputStreamState *> g_streams;
static std::mutex g_streamsMutex;
static uint32_t g_nextId = 1;


static std::string g_lastError;
static std::mutex g_lastErrorMutex;

static void SetLastErrStr(const std::string &msg)
{
    std::lock_guard<std::mutex> lk(g_lastErrorMutex);
    g_lastError = msg;
}

static void SetLastErrorHr(const char *msg, long hr)
{
    char buf[256];
    std::snprintf(buf, sizeof(buf), "%s (HRESULT=0x%08lx)", msg, hr);
    std::lock_guard<std::mutex> lk(g_lastErrorMutex);
    g_lastError = buf;
}

#if defined(EXCLUSIVE_LINUX)
static void SetLastErrorAlsa(const char *msg, int err)
{
    char buf[256];
    std::snprintf(buf, sizeof(buf), "%s (ALSA error: %s)", msg, snd_strerror(err));
    std::lock_guard<std::mutex> lk(g_lastErrorMutex);
    g_lastError = buf;
}
#else
static void SetLastErrorAlsa(const char *msg, int err)
{
    char buf[256];
    std::snprintf(buf, sizeof(buf), "%s (error: %d)", msg, err);
    std::lock_guard<std::mutex> lk(g_lastErrorMutex);
    g_lastError = buf;
}
#endif

static std::string GetLastErrStr()
{
    std::lock_guard<std::mutex> lk(g_lastErrorMutex);
    return g_lastError;
}

static inline void ThrowTypeError(const Napi::Env &env, const std::string &msg)
{
    std::string full = msg;
    std::string last = GetLastErrStr();
    if (!last.empty())
        full.append(" - ").append(last);
    Napi::TypeError::New(env, full).ThrowAsJavaScriptException();
}

static inline void ThrowRuntimeError(const Napi::Env &env, const std::string &msg)
{
    std::string full = msg;
    std::string last = GetLastErrStr();
    if (!last.empty())
        full.append(" - ").append(last);
    Napi::Error::New(env, full).ThrowAsJavaScriptException();
}

// Single-Producer Single-Consumer lock-free ring buffer.
// Writer: JS / Node thread (producer). Reader: audio render thread (consumer).
struct RingBuffer
{
    std::vector<uint8_t> data;
    size_t capacity{0};
    std::atomic<size_t> readPos{0};  // head (consumer)
    std::atomic<size_t> writePos{0}; // tail (producer)

    void init(size_t size)
    {
        // Ensure at least 2 to distinguish full/empty
        capacity = size ? size : 1;
        data.assign(capacity, 0);
        readPos.store(0);
        writePos.store(0);
    }

    size_t size() const { return capacity; }

    // Number of bytes available to read (consumer)
    size_t availableToRead() const
    {
        size_t r = readPos.load(std::memory_order_acquire);
        size_t w = writePos.load(std::memory_order_acquire);
        return (w + capacity - r) % capacity;
    }

    // Number of bytes available to write (producer)
    size_t availableToWrite() const
    {
        return capacity - availableToRead() - 1;
    }

    // Producer writes up to len bytes. Returns actual written.
    size_t write(const uint8_t *src, size_t len)
    {
        if (!src || len == 0)
            return 0;

        size_t r = readPos.load(std::memory_order_acquire);
        size_t t = writePos.load(std::memory_order_relaxed);

        size_t avail = (t >= r) ? (capacity - (t - r) - 1) : (r - t - 1);
        if (avail == 0)
            return 0;
        if (len > avail)
            len = avail;

        size_t first = std::min(len, capacity - t);
        std::memcpy(&data[t], src, first);
        if (len > first)
            std::memcpy(&data[0], src + first, len - first);

        writePos.store((t + len) % capacity, std::memory_order_release);
        return len;
    }

    // Consumer reads up to len bytes. Returns actual read.
    size_t read(uint8_t *dst, size_t len)
    {
        if (!dst || len == 0)
            return 0;

        size_t r = readPos.load(std::memory_order_relaxed);
        size_t t = writePos.load(std::memory_order_acquire);

        size_t avail = (t + capacity - r) % capacity;
        if (avail == 0)
            return 0;
        if (len > avail)
            len = avail;

        size_t first = std::min(len, capacity - r);
        std::memcpy(dst, &data[r], first);
        if (len > first)
            std::memcpy(dst + first, &data[0], len - first);

        readPos.store((r + len) % capacity, std::memory_order_release);
        return len;
    }
};

struct OutputStreamState
{
    unsigned int sampleRate{44100};
    unsigned int channels{2};
    unsigned int bitDepth{16};

    // Cached:
    unsigned int bytesPerFrame{(16 / 8) * 2};
    bool sampleFormatFloat{false};
    bool nativeDsd{false};
    double ringDurationMs{0.0};
    std::string openedBackend{"unknown"};
    bool fallbackUsed{false};
    std::string fallbackReason;

    std::atomic<bool> open{false};
    std::atomic<bool> running{false};
    std::atomic<bool> paused{false};
    std::atomic<bool> cancelled{false};
    // Counts all in-flight operations (sync writes, async writes, pause, resume, getStats, drain).
    // Close() waits for this to reach zero before deleting the state object.
    std::atomic<int> inFlightOps{0};
    std::atomic<bool> closing{false};
    RingBuffer ring;
    // Writers (JS) may wait on this mutex/cv; audio thread never locks the ring.
    std::mutex ringMutex;
    std::condition_variable ringCv;

    // Last observed hardware buffer padding (frames) for latency calc
    std::atomic<uint32_t> lastHardwarePaddingFrames{0};

#if defined(EXCLUSIVE_WIN32)
    IMMDevice *device{nullptr};
    IAudioClient *audioClient{nullptr};
    IAudioRenderClient *renderClient{nullptr};
    HANDLE hEvent{nullptr};
    UINT32 bufferFrames{0};
    bool eventDriven{false};
    bool coInitialized{false};
    std::thread renderThread;
    bool asioMode{false};
    struct IASIOHost *asioDriver{nullptr};
    std::string asioDriverName;
    std::vector<struct ASIOBufferInfoHost> asioBuffers;
    std::vector<long> asioSampleTypes;
    long asioBufferSize{0};
    long requestedBufferFrames{0};
    long asioOutputChannels{0};
    std::atomic<HWND> asioHostWindow{nullptr};
    std::thread asioHostThread;
    HANDLE asioHostReadyEvent{nullptr};
    bool asioPostOutputReady{false};
    std::atomic<uint32_t> asioCallbacks{0};
    std::atomic<uint32_t> asioMessages{0};
    std::atomic<long> asioLastMessageSelector{0};
    std::atomic<uint32_t> asioResetRequests{0};
    std::atomic<uint32_t> asioOverloads{0};
#elif defined(EXCLUSIVE_MACOS)
    AudioComponentInstance audioUnit{nullptr};
#elif defined(EXCLUSIVE_LINUX)
    snd_pcm_t *pcmHandle{nullptr};
    std::thread renderThread;
    snd_pcm_uframes_t bufferSize{0};
    snd_pcm_uframes_t periodSize{0};
#endif
};

//
// Shared helper for blocking ring writes
//
static size_t WriteToRingBlocking(OutputStreamState *s,
                                  const uint8_t *src,
                                  size_t len,
                                  uint32_t timeoutMs)
{
    // CRITICAL FIX: Check running state. If the render thread died, we must stop writing.
    if (!s || !s->open.load() || !s->running.load() || !src || len == 0)
        return 0;

    size_t totalWritten = 0;
    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(timeoutMs);

    while (totalWritten < len && s->running.load() && s->open.load())
    {
        std::unique_lock<std::mutex> lock(s->ringMutex);

        size_t avail = s->ring.availableToWrite();
        if (avail == 0)
        {
            if (timeoutMs == 0)
            {
                // Non-blocking: nothing to do
                break;
            }
            // Wait for space or until stream stops/closes
            if (s->ringCv.wait_until(lock, deadline) == std::cv_status::timeout)
            {
                break;
            }
            continue;
        }

        size_t chunk = std::min(avail, len - totalWritten);
        size_t wrote = s->ring.write(src + totalWritten, chunk);
        totalWritten += wrote;

        if (timeoutMs == 0)
        {
            // Non-blocking write: write whatever fits and exit
            break;
        }
    }

    return totalWritten;
}

#if defined(EXCLUSIVE_WIN32)

static HRESULT GetDefaultRenderDevice(IMMDevice **out)
{
    IMMDeviceEnumerator *enumerator = nullptr;
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator),
        nullptr,
        CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator),
        (void **)&enumerator);
    if (FAILED(hr) || !enumerator)
        return hr;

    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, out);
    enumerator->Release();
    return hr;
}

static bool Utf8ToWide(const std::string &in, std::wstring &out)
{
    out.clear();
    if (in.empty())
        return true;

    int n = MultiByteToWideChar(CP_UTF8, 0, in.c_str(), -1, nullptr, 0);
    if (n <= 0)
        return false;
    out.resize(n);
    if (!MultiByteToWideChar(CP_UTF8, 0, in.c_str(), -1, &out[0], n))
    {
        out.clear();
        return false;
    }
    if (!out.empty() && out.back() == L'\0')
        out.pop_back();
    return true;
}

using ASIOBoolHost = long;
using ASIOErrorHost = long;
using ASIOSampleRateHost = double;
using ASIOSamplesHost = long long;
using ASIOTimeStampHost = long long;

static constexpr ASIOErrorHost ASIO_OK_HOST = 0;
static constexpr ASIOErrorHost ASIO_SUCCESS_HOST = 0x3f4847a0;

enum ASIOSampleTypeHost
{
    ASIOSTInt16MSBHost = 0,
    ASIOSTInt24MSBHost = 1,
    ASIOSTInt32MSBHost = 2,
    ASIOSTFloat32MSBHost = 3,
    ASIOSTFloat64MSBHost = 4,
    ASIOSTInt32MSB16Host = 8,
    ASIOSTInt32MSB18Host = 9,
    ASIOSTInt32MSB20Host = 10,
    ASIOSTInt32MSB24Host = 11,
    ASIOSTInt16LSBHost = 16,
    ASIOSTInt24LSBHost = 17,
    ASIOSTInt32LSBHost = 18,
    ASIOSTFloat32LSBHost = 19,
    ASIOSTFloat64LSBHost = 20,
    ASIOSTInt32LSB16Host = 24,
    ASIOSTInt32LSB18Host = 25,
    ASIOSTInt32LSB20Host = 26,
    ASIOSTInt32LSB24Host = 27,
    ASIOSTDSDInt8LSB1Host = 32,
    ASIOSTDSDInt8MSB1Host = 33,
    ASIOSTDSDInt8NER8Host = 40,
};

struct ASIOBufferInfoHost
{
    ASIOBoolHost isInput;
    long channelNum;
    void *buffers[2];
};

struct ASIOChannelInfoHost
{
    long channel;
    ASIOBoolHost isInput;
    ASIOBoolHost isActive;
    long channelGroup;
    long type;
    char name[32];
};

struct ASIOClockSourceHost
{
    long index;
    long associatedChannel;
    long associatedGroup;
    ASIOBoolHost isCurrentSource;
    char name[32];
};

struct ASIOTimeInfoHost
{
    double speed;
    ASIOTimeStampHost systemTime;
    ASIOSamplesHost samplePosition;
    ASIOSampleRateHost sampleRate;
    long flags;
    char reserved[12];
};

struct ASIOTimeCodeHost
{
    double speed;
    ASIOSamplesHost timeCodeSamples;
    long flags;
    char future[64];
};

struct ASIOTimeHost
{
    long reserved[4];
    ASIOTimeInfoHost timeInfo;
    ASIOTimeCodeHost timeCode;
};

struct ASIOCallbacksHost
{
    void (*bufferSwitch)(long doubleBufferIndex, ASIOBoolHost directProcess);
    void (*sampleRateDidChange)(ASIOSampleRateHost sRate);
    long (*asioMessage)(long selector, long value, void *message, double *opt);
    ASIOTimeHost *(*bufferSwitchTimeInfo)(ASIOTimeHost *params, long doubleBufferIndex, ASIOBoolHost directProcess);
};

struct IASIOHost : public IUnknown
{
    virtual ASIOBoolHost STDMETHODCALLTYPE init(void *sysHandle) = 0;
    virtual void STDMETHODCALLTYPE getDriverName(char *name) = 0;
    virtual long STDMETHODCALLTYPE getDriverVersion() = 0;
    virtual void STDMETHODCALLTYPE getErrorMessage(char *string) = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE start() = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE stop() = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE getChannels(long *numInputChannels, long *numOutputChannels) = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE getLatencies(long *inputLatency, long *outputLatency) = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE getBufferSize(long *minSize, long *maxSize, long *preferredSize, long *granularity) = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE canSampleRate(ASIOSampleRateHost sampleRate) = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE getSampleRate(ASIOSampleRateHost *sampleRate) = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE setSampleRate(ASIOSampleRateHost sampleRate) = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE getClockSources(ASIOClockSourceHost *clocks, long *numSources) = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE setClockSource(long reference) = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE getSamplePosition(ASIOSamplesHost *sPos, ASIOTimeStampHost *tStamp) = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE getChannelInfo(ASIOChannelInfoHost *info) = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE createBuffers(ASIOBufferInfoHost *bufferInfos, long numChannels, long bufferSize, ASIOCallbacksHost *callbacks) = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE disposeBuffers() = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE controlPanel() = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE future(long selector, void *opt) = 0;
    virtual ASIOErrorHost STDMETHODCALLTYPE outputReady() = 0;
};

struct AsioDriverInfoHost
{
    std::string id;
    std::string name;
    CLSID clsid{};
};

static std::mutex g_asioCallbackMutex;
static OutputStreamState *g_asioCallbackState = nullptr;

static bool AsioOk(ASIOErrorHost err)
{
    return err == ASIO_OK_HOST || err == ASIO_SUCCESS_HOST;
}

static std::string WideToUtf8(const std::wstring &in)
{
    if (in.empty())
        return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, in.c_str(), static_cast<int>(in.size()), nullptr, 0, nullptr, nullptr);
    if (n <= 0)
        return {};
    std::string out(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, 0, in.c_str(), static_cast<int>(in.size()), out.data(), n, nullptr, nullptr);
    return out;
}

static std::string GuidToStringUtf8(const CLSID &clsid)
{
    LPOLESTR str = nullptr;
    if (FAILED(StringFromCLSID(clsid, &str)) || !str)
        return {};
    std::wstring ws(str);
    CoTaskMemFree(str);
    return WideToUtf8(ws);
}

static bool ReadAsioDriverClsid(HKEY root, const std::wstring &subkey, CLSID &clsid)
{
    HKEY key = nullptr;
    if (RegOpenKeyExW(root, subkey.c_str(), 0, KEY_READ | KEY_WOW64_64KEY, &key) != ERROR_SUCCESS)
        return false;

    wchar_t clsidText[128]{};
    DWORD type = 0;
    DWORD size = sizeof(clsidText);
    LONG rc = RegQueryValueExW(key, L"CLSID", nullptr, &type, reinterpret_cast<LPBYTE>(clsidText), &size);
    RegCloseKey(key);
    if (rc != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ))
        return false;

    return SUCCEEDED(CLSIDFromString(clsidText, &clsid));
}

static void EnumerateAsioDriversFromRoot(HKEY root, std::vector<AsioDriverInfoHost> &out)
{
    HKEY asioKey = nullptr;
    if (RegOpenKeyExW(root, L"SOFTWARE\\ASIO", 0, KEY_READ | KEY_WOW64_64KEY, &asioKey) != ERROR_SUCCESS)
        return;

    DWORD index = 0;
    wchar_t name[256]{};
    DWORD nameLen = 256;
    while (RegEnumKeyExW(asioKey, index++, name, &nameLen, nullptr, nullptr, nullptr, nullptr) == ERROR_SUCCESS)
    {
        std::wstring subkey = L"SOFTWARE\\ASIO\\";
        subkey += name;
        CLSID clsid{};
        if (ReadAsioDriverClsid(root, subkey, clsid))
        {
            const std::string clsidText = GuidToStringUtf8(clsid);
            if (!clsidText.empty())
            {
                bool exists = false;
                for (const auto &d : out)
                {
                    if (d.id == "asio:" + clsidText)
                    {
                        exists = true;
                        break;
                    }
                }
                if (!exists)
                    out.push_back({"asio:" + clsidText, WideToUtf8(name), clsid});
            }
        }
        nameLen = 256;
        std::memset(name, 0, sizeof(name));
    }

    RegCloseKey(asioKey);
}

static std::vector<AsioDriverInfoHost> EnumerateAsioDrivers()
{
    std::vector<AsioDriverInfoHost> out;
    EnumerateAsioDriversFromRoot(HKEY_LOCAL_MACHINE, out);
    EnumerateAsioDriversFromRoot(HKEY_CURRENT_USER, out);
    return out;
}

static bool ResolveAsioDriver(const std::string &deviceId, AsioDriverInfoHost &driver)
{
    const auto drivers = EnumerateAsioDrivers();
    if (drivers.empty())
        return false;

    if (deviceId.empty())
    {
        driver = drivers.front();
        return true;
    }

    for (const auto &d : drivers)
    {
        if (d.id == deviceId || d.name == deviceId || ("asio:" + d.name) == deviceId)
        {
            driver = d;
            return true;
        }
    }

    return false;
}

static LRESULT CALLBACK AsioHostWindowProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    (void)wParam;
    (void)lParam;
    if (msg == WM_CLOSE)
    {
        DestroyWindow(hwnd);
        return 0;
    }
    if (msg == WM_DESTROY)
    {
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

static bool RegisterAsioHostWindowClass(HINSTANCE hInstance)
{
    static std::once_flag registerFlag;
    static bool registered = false;
    std::call_once(registerFlag, [hInstance]() {
        WNDCLASSEXW wc{};
        wc.cbSize = sizeof(wc);
        wc.lpfnWndProc = AsioHostWindowProc;
        wc.hInstance = hInstance;
        wc.lpszClassName = L"SpectraAsioHostWindow";
        registered = RegisterClassExW(&wc) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
    });
    return registered;
}

static void AsioHostWindowThread(OutputStreamState *s)
{
    HINSTANCE hInstance = GetModuleHandleW(nullptr);
    if (!RegisterAsioHostWindowClass(hInstance))
    {
        if (s && s->asioHostReadyEvent)
            SetEvent(s->asioHostReadyEvent);
        return;
    }

    HWND hwnd = CreateWindowExW(0,
                                L"SpectraAsioHostWindow",
                                L"Spectra ASIO Host",
                                0,
                                0,
                                0,
                                0,
                                0,
                                HWND_MESSAGE,
                                nullptr,
                                hInstance,
                                nullptr);
    if (s)
        s->asioHostWindow.store(hwnd, std::memory_order_release);
    if (s && s->asioHostReadyEvent)
        SetEvent(s->asioHostReadyEvent);
    if (!hwnd)
        return;

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0)
    {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if (s)
        s->asioHostWindow.store(nullptr, std::memory_order_release);
}

static bool StartAsioHostWindow(OutputStreamState *s)
{
    if (!s)
        return false;
    if (s->asioHostWindow.load(std::memory_order_acquire))
        return true;

    s->asioHostReadyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!s->asioHostReadyEvent)
        return false;


    s->asioHostThread = std::thread(AsioHostWindowThread, s);


    const DWORD waitResult = WaitForSingleObject(s->asioHostReadyEvent, 3000);
    CloseHandle(s->asioHostReadyEvent);
    s->asioHostReadyEvent = nullptr;

    const bool ready = waitResult == WAIT_OBJECT_0 && s->asioHostWindow.load(std::memory_order_acquire) != nullptr;
    if (!ready && s->asioHostThread.joinable())
        s->asioHostThread.join();
    return ready;
}

static void StopAsioHostWindow(OutputStreamState *s)
{
    if (!s)
        return;

    HWND hwnd = s->asioHostWindow.exchange(nullptr, std::memory_order_acq_rel);
    if (hwnd)
        PostMessageW(hwnd, WM_CLOSE, 0, 0);
    if (s->asioHostReadyEvent)
    {
        SetEvent(s->asioHostReadyEvent);
        CloseHandle(s->asioHostReadyEvent);
        s->asioHostReadyEvent = nullptr;
    }
    if (s->asioHostThread.joinable())
        s->asioHostThread.join();
}

static void PumpCurrentThreadMessages()
{
    MSG msg;
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE))
    {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}
static inline float ReadFloat32Le(const uint8_t *p)
{
    float v = 0.0f;
    std::memcpy(&v, p, sizeof(v));
    if (v > 1.0f)
        v = 1.0f;
    else if (v < -1.0f)
        v = -1.0f;
    return v;
}

static void WriteAsioSample(void *dst, long sampleType, float v)
{
    if (!dst)
        return;

    auto *b = static_cast<uint8_t *>(dst);
    if (v > 1.0f)
        v = 1.0f;
    else if (v < -1.0f)
        v = -1.0f;

    switch (sampleType)
    {
    case ASIOSTFloat32LSBHost:
        std::memcpy(dst, &v, sizeof(v));
        break;
    case ASIOSTFloat32MSBHost:
    {
        uint8_t le[4]{};
        std::memcpy(le, &v, sizeof(v));
        b[0] = le[3];
        b[1] = le[2];
        b[2] = le[1];
        b[3] = le[0];
        break;
    }
    case ASIOSTFloat64LSBHost:
    case ASIOSTFloat64MSBHost:
    {
        double d = static_cast<double>(v);
        uint8_t le[8]{};
        std::memcpy(le, &d, sizeof(d));
        if (sampleType == ASIOSTFloat64LSBHost)
        {
            std::memcpy(dst, le, sizeof(le));
        }
        else
        {
            for (int i = 0; i < 8; ++i)
                b[i] = le[7 - i];
        }
        break;
    }
    case ASIOSTInt16LSBHost:
    case ASIOSTInt16MSBHost:
    {
        int sample = static_cast<int>(v * 32767.0f);
        if (sample > 32767)
            sample = 32767;
        else if (sample < -32768)
            sample = -32768;
        uint16_t s = static_cast<uint16_t>(static_cast<int16_t>(sample));
        if (sampleType == ASIOSTInt16LSBHost)
        {
            b[0] = static_cast<uint8_t>(s & 0xff);
            b[1] = static_cast<uint8_t>((s >> 8) & 0xff);
        }
        else
        {
            b[0] = static_cast<uint8_t>((s >> 8) & 0xff);
            b[1] = static_cast<uint8_t>(s & 0xff);
        }
        break;
    }
    case ASIOSTInt24LSBHost:
    case ASIOSTInt24MSBHost:
    {
        int sample = static_cast<int>(v * 8388607.0f);
        if (sample > 8388607)
            sample = 8388607;
        else if (sample < -8388608)
            sample = -8388608;
        uint32_t s = static_cast<uint32_t>(sample) & 0x00ffffffu;
        if (sampleType == ASIOSTInt24LSBHost)
        {
            b[0] = static_cast<uint8_t>(s & 0xff);
            b[1] = static_cast<uint8_t>((s >> 8) & 0xff);
            b[2] = static_cast<uint8_t>((s >> 16) & 0xff);
        }
        else
        {
            b[0] = static_cast<uint8_t>((s >> 16) & 0xff);
            b[1] = static_cast<uint8_t>((s >> 8) & 0xff);
            b[2] = static_cast<uint8_t>(s & 0xff);
        }
        break;
    }
    case ASIOSTInt32MSB16Host:
    case ASIOSTInt32MSB18Host:
    case ASIOSTInt32MSB20Host:
    case ASIOSTInt32MSB24Host:
    case ASIOSTInt32MSBHost:
    case ASIOSTInt32LSB16Host:
    case ASIOSTInt32LSB18Host:
    case ASIOSTInt32LSB20Host:
    case ASIOSTInt32LSB24Host:
    case ASIOSTInt32LSBHost:
    default:
    {
        long long sample = static_cast<long long>(v * 2147483647.0f);
        if (sample > 2147483647LL)
            sample = 2147483647LL;
        else if (sample < -2147483648LL)
            sample = -2147483648LL;
        uint32_t s = static_cast<uint32_t>(static_cast<int32_t>(sample));
        const bool msb = sampleType == ASIOSTInt32MSB16Host ||
                         sampleType == ASIOSTInt32MSB18Host ||
                         sampleType == ASIOSTInt32MSB20Host ||
                         sampleType == ASIOSTInt32MSB24Host ||
                         sampleType == ASIOSTInt32MSBHost;
        if (msb)
        {
            b[0] = static_cast<uint8_t>((s >> 24) & 0xff);
            b[1] = static_cast<uint8_t>((s >> 16) & 0xff);
            b[2] = static_cast<uint8_t>((s >> 8) & 0xff);
            b[3] = static_cast<uint8_t>(s & 0xff);
        }
        else
        {
            b[0] = static_cast<uint8_t>(s & 0xff);
            b[1] = static_cast<uint8_t>((s >> 8) & 0xff);
            b[2] = static_cast<uint8_t>((s >> 16) & 0xff);
            b[3] = static_cast<uint8_t>((s >> 24) & 0xff);
        }
        break;
    }
    }
}

static bool IsAsioDsdSampleType(long sampleType)
{
    return sampleType == ASIOSTDSDInt8LSB1Host ||
           sampleType == ASIOSTDSDInt8MSB1Host ||
           sampleType == ASIOSTDSDInt8NER8Host;
}

static uint8_t ReverseBits8(uint8_t v)
{
    v = static_cast<uint8_t>(((v & 0xf0) >> 4) | ((v & 0x0f) << 4));
    v = static_cast<uint8_t>(((v & 0xcc) >> 2) | ((v & 0x33) << 2));
    v = static_cast<uint8_t>(((v & 0xaa) >> 1) | ((v & 0x55) << 1));
    return v;
}

static void WriteAsioDsdSample(void *dst, long sampleType, uint8_t v)
{
    if (!dst)
        return;
    auto *out = static_cast<uint8_t *>(dst);
    if (sampleType == ASIOSTDSDInt8MSB1Host || sampleType == ASIOSTDSDInt8NER8Host)
        *out = ReverseBits8(v);
    else
        *out = v;
}

static size_t AsioSampleStride(long sampleType)
{
    switch (sampleType)
    {
    case ASIOSTDSDInt8LSB1Host:
    case ASIOSTDSDInt8MSB1Host:
    case ASIOSTDSDInt8NER8Host:
        return 1;
    case ASIOSTInt16LSBHost:
    case ASIOSTInt16MSBHost:
        return 2;
    case ASIOSTInt24LSBHost:
    case ASIOSTInt24MSBHost:
        return 3;
    case ASIOSTFloat64LSBHost:
    case ASIOSTFloat64MSBHost:
        return 8;
    default:
        return 4;
    }
}

static long ChooseAsioBufferSize(long minSize,
                                 long maxSize,
                                 long preferredSize,
                                 long granularity,
                                 long requestedFrames,
                                 double bufferMs,
                                 unsigned int sampleRate)
{
    if (preferredSize <= 0)
        preferredSize = minSize > 0 ? minSize : 512;
    if (minSize <= 0)
        minSize = preferredSize;
    if (maxSize < minSize)
        maxSize = minSize;

    long target = preferredSize;
    if (requestedFrames > 0)
    {
        target = requestedFrames;
    }
    else if (bufferMs > 0.0 && sampleRate > 0)
    {
        target = static_cast<long>((static_cast<double>(sampleRate) * bufferMs / 1000.0) + 0.5);
    }

    if (target < minSize)
        target = minSize;
    if (target > maxSize)
        target = maxSize;

    if (granularity > 0)
    {
        long steps = (target - minSize + granularity / 2) / granularity;
        target = minSize + steps * granularity;
        if (target < minSize)
            target = minSize;
        if (target > maxSize)
            target = maxSize;
    }
    else if (granularity == -1)
    {
        long best = minSize;
        for (long p = 1; p > 0 && p <= maxSize; p <<= 1)
        {
            if (p < minSize)
                continue;
            if (std::labs(p - target) < std::labs(best - target))
                best = p;
        }
        target = best;
    }

    return target;
}

static void FillAsioOutput(OutputStreamState *s, long doubleBufferIndex)
{
    if (!s || !s->open.load() || s->asioBuffers.empty())
        return;

    const size_t frames = static_cast<size_t>(s->asioBufferSize > 0 ? s->asioBufferSize : 0);
    const size_t inputBytes = frames * s->bytesPerFrame;
    std::vector<uint8_t> interleaved(inputBytes);
    size_t bytesRead = s->paused.load() ? 0 : s->ring.read(interleaved.data(), inputBytes);
    if (bytesRead < inputBytes)
        std::memset(interleaved.data() + bytesRead, 0, inputBytes - bytesRead);

    for (long ch = 0; ch < s->asioOutputChannels; ++ch)
    {
        if (static_cast<size_t>(ch) >= s->asioBuffers.size())
            break;
        const long sampleType = static_cast<size_t>(ch) < s->asioSampleTypes.size()
            ? s->asioSampleTypes[static_cast<size_t>(ch)]
            : ASIOSTFloat32LSBHost;
        uint8_t *dst = static_cast<uint8_t *>(s->asioBuffers[static_cast<size_t>(ch)].buffers[doubleBufferIndex ? 1 : 0]);
        const size_t stride = AsioSampleStride(sampleType);
        if (!dst)
            continue;

        for (size_t frame = 0; frame < frames; ++frame)
        {
            const unsigned int srcCh = static_cast<unsigned int>(ch) < s->channels ? static_cast<unsigned int>(ch) : 0;
            if (s->nativeDsd)
            {
                const size_t srcOffset = frame * s->bytesPerFrame + static_cast<size_t>(srcCh);
                const uint8_t v = srcOffset < interleaved.size() ? interleaved[srcOffset] : 0;
                WriteAsioDsdSample(dst + frame * stride, sampleType, v);
            }
            else
            {
                const size_t srcOffset = frame * s->bytesPerFrame + static_cast<size_t>(srcCh) * 4;
                float v = 0.0f;
                if (srcOffset + 4 <= interleaved.size())
                    v = ReadFloat32Le(interleaved.data() + srcOffset);
                WriteAsioSample(dst + frame * stride, sampleType, v);
            }
        }
    }

    s->lastHardwarePaddingFrames.store(static_cast<uint32_t>(frames));
    s->asioCallbacks.fetch_add(1, std::memory_order_relaxed);
    if (s->asioDriver && s->asioPostOutputReady)
        s->asioDriver->outputReady();
    s->ringCv.notify_all();
}

static void AsioBufferSwitch(long doubleBufferIndex, ASIOBoolHost directProcess)
{
    (void)directProcess;
    std::lock_guard<std::mutex> lock(g_asioCallbackMutex);
    FillAsioOutput(g_asioCallbackState, doubleBufferIndex);
}

static void AsioSampleRateDidChange(ASIOSampleRateHost sRate)
{
    std::lock_guard<std::mutex> lock(g_asioCallbackMutex);
    if (g_asioCallbackState && sRate > 0)
        g_asioCallbackState->sampleRate = static_cast<unsigned int>(sRate);
}

static bool AsioMessageSelectorSupported(long value)
{
    switch (value)
    {
    case 2:  // kAsioEngineVersion
    case 3:  // kAsioResetRequest
    case 4:  // kAsioBufferSizeChange
    case 5:  // kAsioResyncRequest
    case 6:  // kAsioLatenciesChanged
    case 7:  // kAsioSupportsTimeInfo
    case 8:  // kAsioSupportsTimeCode
    case 15: // kAsioOverload
        return true;
    default:
        return false;
    }
}

static void NoteAsioMessage(long selector)
{
    std::lock_guard<std::mutex> lock(g_asioCallbackMutex);
    if (!g_asioCallbackState)
        return;
    g_asioCallbackState->asioMessages.fetch_add(1, std::memory_order_relaxed);
    g_asioCallbackState->asioLastMessageSelector.store(selector, std::memory_order_relaxed);
    if (selector == 3)
        g_asioCallbackState->asioResetRequests.fetch_add(1, std::memory_order_relaxed);
    else if (selector == 15)
        g_asioCallbackState->asioOverloads.fetch_add(1, std::memory_order_relaxed);
}

static long AsioMessage(long selector, long value, void *message, double *opt)
{
    (void)message;
    (void)opt;
    NoteAsioMessage(selector);
    switch (selector)
    {
    case 1: // kAsioSelectorSupported
        return AsioMessageSelectorSupported(value) ? 1 : 0;
    case 2: // kAsioEngineVersion
        return 2;
    case 3: // kAsioResetRequest
    case 4: // kAsioBufferSizeChange
    case 5: // kAsioResyncRequest
    case 6: // kAsioLatenciesChanged
        return 1;
    case 7: // kAsioSupportsTimeInfo
    case 8: // kAsioSupportsTimeCode
        return 1;
    case 15: // kAsioOverload
        return 1;
    default:
        return 0;
    }
}

static ASIOTimeHost *AsioBufferSwitchTimeInfo(ASIOTimeHost *params, long doubleBufferIndex, ASIOBoolHost directProcess)
{
    AsioBufferSwitch(doubleBufferIndex, directProcess);
    return params;
}

static ASIOCallbacksHost g_asioCallbacks{
    AsioBufferSwitch,
    AsioSampleRateDidChange,
    AsioMessage,
    AsioBufferSwitchTimeInfo,
};

static bool InitAsio(OutputStreamState *s,
                     const std::string &deviceId,
                     HWND hostWindow,
                     double bufferMs,
                     long requestedBufferFrames,
                     bool bitPerfect,
                     bool nativeDsd)
{
    if (!s)
        return false;
    s->nativeDsd = nativeDsd;

    SetLastErrStr("");

    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE)
    {
        SetLastErrorHr("CoInitializeEx failed", hr);
        return false;
    }
    s->coInitialized = SUCCEEDED(hr);
    auto cleanupFailedCom = [&]() {
        if (s->coInitialized)
        {
            CoUninitialize();
            s->coInitialized = false;
        }
    };
    AsioDriverInfoHost driver{};
    if (!ResolveAsioDriver(deviceId, driver))
    {
        SetLastErrStr("No installed ASIO driver matched the selected output device");
        cleanupFailedCom();
        return false;
    }

    IASIOHost *asio = nullptr;
    constexpr DWORD asioClsContext = CLSCTX_INPROC_SERVER | CLSCTX_LOCAL_SERVER;
    hr = CoCreateInstance(driver.clsid, nullptr, asioClsContext, driver.clsid, reinterpret_cast<void **>(&asio));
    if (FAILED(hr) || !asio)
    {
        IUnknown *unknown = nullptr;
        HRESULT fallbackHr = CoCreateInstance(driver.clsid, nullptr, asioClsContext, IID_IUnknown, reinterpret_cast<void **>(&unknown));
        if (SUCCEEDED(fallbackHr) && unknown)
        {
            void *queried = nullptr;
            fallbackHr = unknown->QueryInterface(driver.clsid, &queried);
            unknown->Release();
            if (SUCCEEDED(fallbackHr) && queried)
                asio = reinterpret_cast<IASIOHost *>(queried);
        }

        if (!asio)
        {
            SetLastErrorHr("CoCreateInstance(ASIO driver) failed", FAILED(hr) ? hr : fallbackHr);
            cleanupFailedCom();
            return false;
        }
    }

    const bool hasHostPump = StartAsioHostWindow(s);
    HWND hwnd = hasHostPump ? s->asioHostWindow.load(std::memory_order_acquire) : hostWindow;
    if (!hwnd)
        hwnd = GetForegroundWindow();
    if (!hwnd)
        hwnd = GetDesktopWindow();
    if (!asio->init(hwnd))
    {
        char errMsg[128]{};
        asio->getErrorMessage(errMsg);
        std::string msg = "ASIO driver init failed";
        if (errMsg[0])
            msg.append(": ").append(errMsg);
        SetLastErrStr(msg);
        StopAsioHostWindow(s);
        asio->Release();
        cleanupFailedCom();
        return false;
    }

    ASIOSampleRateHost requestedRate = static_cast<ASIOSampleRateHost>(s->sampleRate);
    if (requestedRate > 0)
    {
        if (AsioOk(asio->canSampleRate(requestedRate)))
        {
            ASIOErrorHost setRateErr = asio->setSampleRate(requestedRate);
            if (!AsioOk(setRateErr) && bitPerfect)
            {
                SetLastErrStr("ASIO driver rejected the requested bit-perfect sample rate");
                StopAsioHostWindow(s);
                asio->Release();
                cleanupFailedCom();
                return false;
            }
        }
        else if (bitPerfect)
        {
            SetLastErrStr("ASIO driver does not support the requested bit-perfect sample rate");
            StopAsioHostWindow(s);
            asio->Release();
            cleanupFailedCom();
            return false;
        }
    }

    ASIOSampleRateHost actualRate = 0;
    if (AsioOk(asio->getSampleRate(&actualRate)) && actualRate > 0)
    {
        const double delta = actualRate > requestedRate ? actualRate - requestedRate : requestedRate - actualRate;
        if (bitPerfect && requestedRate > 0 && delta > 0.5)
        {
            SetLastErrStr("ASIO driver switched to a different sample rate in bit-perfect mode");
            StopAsioHostWindow(s);
            asio->Release();
            cleanupFailedCom();
            return false;
        }
        s->sampleRate = static_cast<unsigned int>(actualRate);
    }

    long inputChannels = 0;
    long outputChannels = 0;
    if (!AsioOk(asio->getChannels(&inputChannels, &outputChannels)) || outputChannels <= 0)
    {
        SetLastErrStr("ASIO driver has no output channels");
        StopAsioHostWindow(s);
        asio->Release();
        cleanupFailedCom();
        return false;
    }

    s->channels = s->channels > 0 ? s->channels : 2;
    if (static_cast<long>(s->channels) > outputChannels)
        s->channels = static_cast<unsigned int>(outputChannels);

    long minSize = 0;
    long maxSize = 0;
    long preferredSize = 0;
    long granularity = 0;
    if (!AsioOk(asio->getBufferSize(&minSize, &maxSize, &preferredSize, &granularity)) || preferredSize <= 0)
    {
        SetLastErrStr("ASIO driver did not provide a usable buffer size");
        StopAsioHostWindow(s);
        asio->Release();
        cleanupFailedCom();
        return false;
    }

    s->asioOutputChannels = static_cast<long>(s->channels);
    s->requestedBufferFrames = requestedBufferFrames;
    s->asioBufferSize = ChooseAsioBufferSize(minSize, maxSize, preferredSize, granularity, requestedBufferFrames, bufferMs, s->sampleRate);
    s->bitDepth = nativeDsd ? 8 : 32;
    s->sampleFormatFloat = !nativeDsd;
    s->bytesPerFrame = (nativeDsd ? 1 : 4) * s->channels;
    s->asioBuffers.assign(static_cast<size_t>(s->asioOutputChannels), {});
    s->asioSampleTypes.assign(static_cast<size_t>(s->asioOutputChannels), ASIOSTFloat32LSBHost);

    for (long ch = 0; ch < s->asioOutputChannels; ++ch)
    {
        ASIOChannelInfoHost info{};
        info.channel = ch;
        info.isInput = 0;
        if (AsioOk(asio->getChannelInfo(&info)))
            s->asioSampleTypes[static_cast<size_t>(ch)] = info.type;

        if (nativeDsd && !IsAsioDsdSampleType(s->asioSampleTypes[static_cast<size_t>(ch)]))
        {
            SetLastErrStr("Selected ASIO driver does not expose native DSD output buffers");
            StopAsioHostWindow(s);
            asio->Release();
            cleanupFailedCom();
            return false;
        }

        ASIOBufferInfoHost buffer{};
        buffer.isInput = 0;
        buffer.channelNum = ch;
        buffer.buffers[0] = nullptr;
        buffer.buffers[1] = nullptr;
        s->asioBuffers[static_cast<size_t>(ch)] = buffer;
    }

    if (!AsioOk(asio->createBuffers(s->asioBuffers.data(), s->asioOutputChannels, s->asioBufferSize, &g_asioCallbacks)))
    {
        SetLastErrStr("ASIO createBuffers failed");
        StopAsioHostWindow(s);
        asio->Release();
        cleanupFailedCom();
        return false;
    }

    s->asioPostOutputReady = AsioOk(asio->outputReady());

    if (nativeDsd && s->sampleRate > 1000000)
        s->sampleRate = s->sampleRate / 8;

    double ringMs = bufferMs > 0.0 ? bufferMs * 4.0 : 80.0;
    if (ringMs < 40.0)
        ringMs = 40.0;
    if (ringMs > 500.0)
        ringMs = 500.0;
    size_t ringFrames = static_cast<size_t>((static_cast<double>(s->sampleRate) * ringMs / 1000.0) + 0.5);
    if (ringFrames < static_cast<size_t>(s->asioBufferSize * 4))
        ringFrames = static_cast<size_t>(s->asioBufferSize * 4);
    s->ring.init(ringFrames * s->bytesPerFrame);
    s->ringDurationMs = static_cast<double>(ringFrames) * 1000.0 / static_cast<double>(s->sampleRate);

    s->asioDriver = asio;
    s->asioDriverName = driver.name;
    s->asioMode = true;
    s->openedBackend = nativeDsd ? "native-dsd" : "asio";
    s->open.store(true);
    s->running.store(true);

    {
        std::lock_guard<std::mutex> lock(g_asioCallbackMutex);
        g_asioCallbackState = s;
    }

    if (!AsioOk(asio->start()))
    {
        {
            std::lock_guard<std::mutex> lock(g_asioCallbackMutex);
            if (g_asioCallbackState == s)
                g_asioCallbackState = nullptr;
        }
        asio->disposeBuffers();
        StopAsioHostWindow(s);
        asio->Release();
        s->asioDriver = nullptr;
        s->open.store(false);
        s->running.store(false);
        SetLastErrStr("ASIO start failed");
        cleanupFailedCom();
        return false;
    }

    const auto callbackDeadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
    while (s->asioCallbacks.load(std::memory_order_relaxed) == 0 &&
           s->running.load() &&
           std::chrono::steady_clock::now() < callbackDeadline)
    {
        PumpCurrentThreadMessages();
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    if (s->asioCallbacks.load(std::memory_order_relaxed) == 0)
    {
        {
            std::lock_guard<std::mutex> lock(g_asioCallbackMutex);
            if (g_asioCallbackState == s)
                g_asioCallbackState = nullptr;
        }
        asio->stop();
        asio->disposeBuffers();
        StopAsioHostWindow(s);
        asio->Release();
        s->asioDriver = nullptr;
        s->open.store(false);
        s->running.store(false);
        SetLastErrStr("ASIO start succeeded but the driver produced no buffer callbacks");
        cleanupFailedCom();
        return false;
    }

    return true;
}

static int WriteAsio(OutputStreamState *s, const uint8_t *data, size_t len, bool blocking)
{
    if (!s || !s->open.load() || !s->running.load())
        return -1;
    if (!data || len == 0)
        return 0;
    uint32_t timeoutMs = blocking ? 2000u : 0u;
    size_t written = WriteToRingBlocking(s, data, len, timeoutMs);
    return static_cast<int>(written);
}

static void CloseAsio(OutputStreamState *s)
{
    if (!s)
        return;

    s->open.store(false);
    s->running.store(false);
    s->ringCv.notify_all();

    {
        std::lock_guard<std::mutex> lock(g_asioCallbackMutex);
        if (g_asioCallbackState == s)
            g_asioCallbackState = nullptr;
    }

    if (s->asioDriver)
    {
        s->asioDriver->stop();
        s->asioDriver->disposeBuffers();
        StopAsioHostWindow(s);
        s->asioDriver->Release();
        s->asioDriver = nullptr;
    }
    else
    {
        StopAsioHostWindow(s);
    }

    s->asioBuffers.clear();
    s->asioSampleTypes.clear();

    if (s->coInitialized)
    {
        CoUninitialize();
        s->coInitialized = false;
    }
}

static void BuildFormat(
    unsigned int sampleRate,
    unsigned int channels,
    unsigned int bitDepth,
    bool isFloat,
    WAVEFORMATEXTENSIBLE &fmt)
{
    std::memset(&fmt, 0, sizeof(fmt));
    fmt.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    fmt.Format.nChannels = static_cast<WORD>(channels);
    fmt.Format.nSamplesPerSec = sampleRate;
    fmt.Format.wBitsPerSample = static_cast<WORD>(bitDepth);
    fmt.Format.nBlockAlign =
        static_cast<WORD>((fmt.Format.nChannels * fmt.Format.wBitsPerSample) / 8);
    fmt.Format.nAvgBytesPerSec =
        fmt.Format.nBlockAlign * fmt.Format.nSamplesPerSec;
    fmt.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    fmt.Samples.wValidBitsPerSample = fmt.Format.wBitsPerSample;
    if (channels == 1)
    {
        fmt.dwChannelMask = SPEAKER_FRONT_CENTER;
    }
    else if (channels == 2)
    {
        fmt.dwChannelMask = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
    }
    else
    {
        fmt.dwChannelMask = 0;
    }
    fmt.SubFormat = isFloat ? KSDATAFORMAT_SUBTYPE_IEEE_FLOAT : KSDATAFORMAT_SUBTYPE_PCM;
}

static bool IsWasapiFloatFormat(const WAVEFORMATEX *fmt)
{
    if (!fmt)
        return false;

    if (fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT)
        return true;

    if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
        fmt->cbSize >= sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX))
    {
        const WAVEFORMATEXTENSIBLE *ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE *>(fmt);
        return IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
    }

    return false;
}

static void WasapiRenderThread(OutputStreamState *s)
{
    DBG("WasapiRenderThread: starting");
    if (!s || !s->audioClient || !s->renderClient || !s->hEvent)
    {
        DBG("WasapiRenderThread: invalid state");
        if (s)
            s->open.store(false);
        return;
    }

    const UINT32 frameBytes = s->bytesPerFrame;
    s->running.store(true);

    // Register with MMCSS for high-priority audio processing
    HANDLE mmcssHandle = nullptr;
    DWORD mmcssTaskIndex = 0;
    mmcssHandle = AvSetMmThreadCharacteristicsA("Pro Audio", &mmcssTaskIndex);

    if (s->bufferFrames > 0 && s->bytesPerFrame > 0)
    {
        BYTE *data = nullptr;
        HRESULT primeHr = s->renderClient->GetBuffer(s->bufferFrames, &data);
        if (SUCCEEDED(primeHr) && data)
        {
            std::memset(data, 0, static_cast<size_t>(s->bufferFrames) * s->bytesPerFrame);
            primeHr = s->renderClient->ReleaseBuffer(s->bufferFrames, 0);
        }
        if (FAILED(primeHr))
        {
            SetLastErrorHr("WASAPI initial buffer prime failed", primeHr);
            s->running.store(false);
            s->open.store(false);
            if (mmcssHandle)
                AvRevertMmThreadCharacteristics(mmcssHandle);
            return;
        }
    }

    HRESULT hr = s->audioClient->Start();
    if (FAILED(hr))
    {
        SetLastErrorHr("IAudioClient::Start failed", hr);
        s->running.store(false);
        s->open.store(false);
        if (mmcssHandle)
            AvRevertMmThreadCharacteristics(mmcssHandle);
        return;
    }

    // Event-driven exclusive streams may not signal immediately until the
    // first buffer is released. Wake the loop once so it can prime WASAPI.
    SetEvent(s->hEvent);

    std::vector<uint8_t> temp;

    while (s->running.load() && s->open.load())
    {
        // Shared mode uses the WASAPI event callback. Exclusive mode is
        // timer/padding-polled because some drivers open exclusive event
        // streams successfully but never signal/drain them.
        DWORD waitRes = s->eventDriven
            ? WaitForSingleObject(s->hEvent, 20)
            : WaitForSingleObject(s->hEvent, 5);

        if (!s->running.load())
            break;

        if (waitRes != WAIT_OBJECT_0 && waitRes != WAIT_TIMEOUT)
            break;

        UINT32 padding = 0;
        hr = s->audioClient->GetCurrentPadding(&padding);
        if (FAILED(hr))
        {
            DBG("WasapiRenderThread: Device lost during padding check");
            break;
        }

        s->lastHardwarePaddingFrames.store(padding);

        UINT32 framesToWrite = (s->bufferFrames > padding) ? (s->bufferFrames - padding) : 0;
        if (framesToWrite == 0)
            continue;

        BYTE *data = nullptr;
        hr = s->renderClient->GetBuffer(framesToWrite, &data);
        if (FAILED(hr) || !data)
        {
            DBG("WasapiRenderThread: GetBuffer failed");
            break;
        }

        size_t bytesRequested = static_cast<size_t>(framesToWrite) * frameBytes;

        if (s->paused.load())
        {
            // Fill with explicit silence when paused to prevent buzzing/hissing
            std::memset(data, 0, bytesRequested);
        }
        else
        {
            temp.resize(bytesRequested);
            size_t bytesRead = s->ring.read(temp.data(), bytesRequested);

            if (bytesRead > 0)
            {
                std::memcpy(data, temp.data(), bytesRead);
                // If the ring buffer had less than requested, fill the remainder with silence
                if (bytesRead < bytesRequested)
                {
                    std::memset(data + bytesRead, 0, bytesRequested - bytesRead);
                }
            }
            else
            {
                // Ring buffer is empty (underrun)
                std::memset(data, 0, bytesRequested);
            }
        }

        // Release the buffer to the hardware
        hr = s->renderClient->ReleaseBuffer(framesToWrite, 0);
        if (FAILED(hr))
        {
            DBG("WasapiRenderThread: ReleaseBuffer failed");
            break;
        }

        // Notify blocking writers (writeAsync workers) that space is now available
        s->ringCv.notify_all();
    }

    DBG("WasapiRenderThread: stopping");
    s->audioClient->Stop();
    s->running.store(false);
    s->open.store(false);
    s->ringCv.notify_all();
    if (mmcssHandle)
        AvRevertMmThreadCharacteristics(mmcssHandle);
}
static bool InitWasapi(OutputStreamState *s,
                       const std::string &deviceId,
                       bool exclusive,
                       double bufferMs,
                       bool bitPerfect)
{
    if (!s)
        return false;

    SetLastErrStr("");
    DBG("InitWasapi: starting");
    DBG(exclusive ? "InitWasapi: exclusive mode" : "InitWasapi: shared mode");

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE)
    {
        SetLastErrorHr("CoInitializeEx failed", hr);
        return false;
    }
    s->coInitialized = SUCCEEDED(hr);

    IMMDevice *device = nullptr;
    if (!deviceId.empty())
    {
        std::wstring wId;
        if (!Utf8ToWide(deviceId, wId))
        {
            SetLastErrStr("Invalid deviceId encoding");
            return false;
        }

        IMMDeviceEnumerator *enumerator = nullptr;
        hr = CoCreateInstance(
            __uuidof(MMDeviceEnumerator),
            nullptr,
            CLSCTX_ALL,
            __uuidof(IMMDeviceEnumerator),
            (void **)&enumerator);
        if (FAILED(hr) || !enumerator)
        {
            SetLastErrorHr("Create MMDeviceEnumerator failed", hr);
            {
                char tmp[256];
                std::snprintf(tmp, sizeof(tmp), "InitWasapi ERROR: %s (hr=0x%08lx)", "CoCreateInstance", hr);
                DBG(tmp);
            }
            return false;
        }

        hr = enumerator->GetDevice(wId.c_str(), &device);
        enumerator->Release();
    }
    else
    {
        hr = GetDefaultRenderDevice(&device);
    }

    if (FAILED(hr) || !device)
    {
        SetLastErrorHr("Get IMMDevice failed", hr);
        {
            char tmp[256];
            std::snprintf(tmp, sizeof(tmp), "InitWasapi ERROR: %s (hr=0x%08lx)", "Get IMMDevice", hr);
            DBG(tmp);
        }
        return false;
    }

    // Don't store device in s yet â€” assign only on full success to avoid leaks on retry.
    IAudioClient *client = nullptr;
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                          (void **)&client);
    if (FAILED(hr) || !client)
    {
        SetLastErrorHr("IMMDevice::Activate(IAudioClient) failed", hr);
        device->Release();
        return false;
    }

    WAVEFORMATEXTENSIBLE reqExt{};
    WAVEFORMATEX *formatToUse = nullptr;
    WAVEFORMATEX *mixFormat = nullptr;

    if (exclusive)
    {
        // If bitPerfect is true, require exact requested format. If false,
        // try negotiating down to commonly supported formats (float32 -> int32 -> 24 -> 16).
        bool found = false;

        std::vector<std::pair<unsigned int, bool>> candidates;
        if (s->bitDepth == 32)
        {
            // try float32 first, then int32, then 24, then 16
            candidates.push_back({32, true});
            candidates.push_back({32, false});
            candidates.push_back({24, false});
            candidates.push_back({16, false});
        }
        else if (s->bitDepth == 24)
        {
            candidates.push_back({24, false});
            candidates.push_back({16, false});
        }
        else
        {
            candidates.push_back({s->bitDepth, false});
            if (s->bitDepth != 16)
                candidates.push_back({16, false});
        }

        // If bitPerfect requested, narrow candidates to only exact match
        if (bitPerfect)
        {
            candidates.clear();
            bool isFloat = (s->bitDepth == 32); // prefer float for 32-bit if requested
            candidates.push_back({s->bitDepth, isFloat});
        }

        for (const auto &c : candidates)
        {
            BuildFormat(s->sampleRate, s->channels, c.first, c.second, reqExt);
            hr = client->IsFormatSupported(
                AUDCLNT_SHAREMODE_EXCLUSIVE, &reqExt.Format, nullptr);
            if (hr == S_OK)
            {
                // adopt negotiated format
                s->bitDepth = c.first;
                s->sampleFormatFloat = c.second;
                s->bytesPerFrame = (s->bitDepth / 8) * s->channels;
                formatToUse = &reqExt.Format;
                found = true;
                break;
            }
        }

        if (!found)
        {
            client->Release();
            device->Release();
            SetLastErrorHr("Exclusive format not supported", hr);
            {
                char tmp[256];
                std::snprintf(tmp, sizeof(tmp), "InitWasapi ERROR: %s (hr=0x%08lx)", "IsFormatSupported", hr);
                DBG(tmp);
            }
            return false;
        }
    }
    else
    {
        hr = client->GetMixFormat(&mixFormat);
        if (FAILED(hr) || !mixFormat)
        {
            client->Release();
            device->Release();
            SetLastErrorHr("GetMixFormat failed", hr);
            {
                char tmp[256];
                std::snprintf(tmp, sizeof(tmp), "InitWasapi ERROR: %s (hr=0x%08lx)", "GetMixFormat", hr);
                DBG(tmp);
            }
            return false;
        }

        s->sampleRate = mixFormat->nSamplesPerSec;
        s->channels = mixFormat->nChannels;
        s->bitDepth = mixFormat->wBitsPerSample;
        s->sampleFormatFloat = IsWasapiFloatFormat(mixFormat);
        formatToUse = mixFormat;
    }

    s->bytesPerFrame = (s->bitDepth / 8) * s->channels;

    REFERENCE_TIME hnsBuffer = exclusive ? 0 : 1000000; // exclusive: endpoint minimum period
    REFERENCE_TIME hnsPeriodicity = 0;
    HRESULT initHr;
    if (exclusive)
    {
        initHr = client->Initialize(
            AUDCLNT_SHAREMODE_EXCLUSIVE,
            0,
            hnsBuffer,
            hnsPeriodicity,
            formatToUse,
            NULL);

        // Some devices require a buffer size aligned to the device period.
        // Per MSDN: on AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, call GetBufferSize,
        // recompute hns from the returned frame count, release and re-Activate.
        if (initHr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED)
        {
            UINT32 alignedFrames = 0;
            if (SUCCEEDED(client->GetBufferSize(&alignedFrames)) && alignedFrames > 0)
            {
                REFERENCE_TIME hnsAligned = static_cast<REFERENCE_TIME>(
                    10000.0 * 1000.0 * alignedFrames / s->sampleRate + 0.5);
                client->Release();
                client = nullptr;
                hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                      (void **)&client);
                if (SUCCEEDED(hr) && client)
                {
                    initHr = client->Initialize(
                        AUDCLNT_SHAREMODE_EXCLUSIVE,
                        0,
                        hnsAligned,
                        0,
                        formatToUse,
                        NULL);
                }
                else
                {
                    initHr = hr; // propagate re-Activate failure
                }
            }
        }
    }
    else
    {
        initHr = client->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            0,
            0,
            formatToUse,
            NULL);
    }

    if (FAILED(initHr))
    {
        if (mixFormat)
            CoTaskMemFree(mixFormat);
        if (client)
            client->Release();
        device->Release();
        {
            char tmp[256];
            std::snprintf(tmp, sizeof(tmp), "InitWasapi ERROR: %s (hr=0x%08lx)", "Initialize", initHr);
            DBG(tmp);
        }
        SetLastErrorHr("IAudioClient::Initialize failed", initHr);
        return false;
    }

    if (mixFormat)
        CoTaskMemFree(mixFormat);

    UINT32 bufferFrames = 0;
    hr = client->GetBufferSize(&bufferFrames);
    if (FAILED(hr) || bufferFrames == 0)
    {
        client->Release();
        device->Release();
        SetLastErrorHr("GetBufferSize failed", hr);
        return false;
    }

    HANDLE hEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    if (!hEvent)
    {
        client->Release();
        device->Release();
        SetLastErrStr("CreateEvent failed");
        return false;
    }

    bool eventDriven = !exclusive;
    if (eventDriven)
    {
        hr = client->SetEventHandle(hEvent);
        if (FAILED(hr))
        {
            CloseHandle(hEvent);
            client->Release();
            device->Release();
            SetLastErrorHr("SetEventHandle failed", hr);
            return false;
        }
    }

    IAudioRenderClient *render = nullptr;
    hr = client->GetService(__uuidof(IAudioRenderClient), (void **)&render);
    if (FAILED(hr) || !render)
    {
        CloseHandle(hEvent);
        client->Release();
        device->Release();
        SetLastErrorHr("GetService(IAudioRenderClient) failed", hr);
        return false;
    }

    // All resources acquired â€” safe to store in state now
    s->device = device;
    s->audioClient = client;
    s->renderClient = render;
    s->hEvent = hEvent;
    s->bufferFrames = bufferFrames;
    s->eventDriven = eventDriven;

    // Configure ring buffer based on bufferMs, with a minimum size
    if (bufferMs < 20.0)
        bufferMs = 20.0;
    if (bufferMs > 2000.0)
        bufferMs = 2000.0;

    double ringFramesD = (static_cast<double>(s->sampleRate) * bufferMs) / 1000.0;
    // At least 2 hardware buffers worth
    if (ringFramesD < static_cast<double>(bufferFrames) * 2.0)
        ringFramesD = static_cast<double>(bufferFrames) * 2.0;

    size_t ringFrames = static_cast<size_t>(ringFramesD);
    size_t ringBytes = ringFrames * s->bytesPerFrame;

    s->ring.init(ringBytes);
    s->ringDurationMs = static_cast<double>(ringFrames) * 1000.0 / static_cast<double>(s->sampleRate);

    s->openedBackend = exclusive ? "exclusive" : "shared";
    s->open.store(true);
    s->running.store(false);

    s->renderThread = std::thread(WasapiRenderThread, s);
    return true;
}

static void CloseWasapi(OutputStreamState *s)
{
    if (!s)
        return;

    // Order matters:
    // 1. Mark open/running false to stop new writes and loop conditions
    s->open.store(false);
    s->running.store(false);

    if (s->hEvent)
    {
        SetEvent(s->hEvent);
    }

    s->ringCv.notify_all();

    if (s->renderThread.joinable())
    {
        s->renderThread.join();
    }

    if (s->renderClient)
    {
        s->renderClient->Release();
        s->renderClient = nullptr;
    }

    if (s->audioClient)
    {
        s->audioClient->Stop();
        s->audioClient->Release();
        s->audioClient = nullptr;
    }

    if (s->device)
    {
        s->device->Release();
        s->device = nullptr;
    }

    if (s->hEvent)
    {
        CloseHandle(s->hEvent);
        s->hEvent = nullptr;
    }

    if (s->coInitialized)
    {
        CoUninitialize();
        s->coInitialized = false;
    }
}

static int WriteWasapi(OutputStreamState *s, const uint8_t *data, size_t len, bool blocking)
{
    if (!s || !s->open.load())
        return -1;
    if (!data || len == 0)
        return 0;
    // CRITICAL: Return error if render thread is dead
    if (!s->running.load())
        return -1;

    uint32_t timeoutMs = blocking ? 2000u : 0u;
    size_t written = WriteToRingBlocking(s, data, len, timeoutMs);
    return static_cast<int>(written);
}

static Napi::Array GetWasapiDevices(const Napi::Env &env)
{
    Napi::Array arr = Napi::Array::New(env);

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool didCoInit = SUCCEEDED(hr);

    IMMDeviceEnumerator *enumerator = nullptr;
    hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator),
        nullptr,
        CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator),
        (void **)&enumerator);
    if (FAILED(hr) || !enumerator)
    {
        if (didCoInit)
            CoUninitialize();
        return arr;
    }

    IMMDeviceCollection *collection = nullptr;
    hr = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &collection);
    if (FAILED(hr) || !collection)
    {
        enumerator->Release();
        if (didCoInit)
            CoUninitialize();
        return arr;
    }

    IMMDevice *defaultDevice = nullptr;
    std::wstring defaultIdW;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &defaultDevice)) &&
        defaultDevice)
    {
        LPWSTR id = nullptr;
        if (SUCCEEDED(defaultDevice->GetId(&id)) && id)
        {
            defaultIdW = id;
            CoTaskMemFree(id);
        }
        defaultDevice->Release();
    }

    UINT count = 0;
    collection->GetCount(&count);
    uint32_t outIdx = 0;

    for (UINT i = 0; i < count; ++i)
    {
        IMMDevice *dev = nullptr;
        if (FAILED(collection->Item(i, &dev)) || !dev)
            continue;

        LPWSTR id = nullptr;
        if (FAILED(dev->GetId(&id)) || !id)
        {
            dev->Release();
            continue;
        }

        IPropertyStore *props = nullptr;
        PROPVARIANT pv;
        PropVariantInit(&pv);
        std::string name = "Unknown device";

        if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props)) && props)
        {
            if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &pv)))
            {
                if (pv.vt == VT_LPWSTR && pv.pwszVal)
                {
                    int need = WideCharToMultiByte(CP_UTF8, 0, pv.pwszVal, -1, nullptr, 0, nullptr, nullptr);
                    if (need > 0)
                    {
                        std::string utf8(need, '\0');
                        WideCharToMultiByte(CP_UTF8, 0, pv.pwszVal, -1, &utf8[0], need, nullptr, nullptr);
                        if (!utf8.empty() && utf8.back() == '\0')
                            utf8.pop_back();
                        name = utf8;
                    }
                }
                PropVariantClear(&pv);
            }
            props->Release();
        }

        int needId = WideCharToMultiByte(CP_UTF8, 0, id, -1, nullptr, 0, nullptr, nullptr);
        std::string idUtf8;
        if (needId > 0)
        {
            idUtf8.resize(needId);
            WideCharToMultiByte(CP_UTF8, 0, id, -1, &idUtf8[0], needId, nullptr, nullptr);
            if (!idUtf8.empty() && idUtf8.back() == '\0')
                idUtf8.pop_back();
        }

        bool isDefault = (!defaultIdW.empty() && defaultIdW == std::wstring(id));

        Napi::Object obj = Napi::Object::New(env);
        obj.Set("id", Napi::String::New(env, idUtf8));
        obj.Set("name", Napi::String::New(env, name));
        obj.Set("isDefault", Napi::Boolean::New(env, isDefault));
        obj.Set("api", Napi::String::New(env, "wasapi"));

        Napi::Array rates = Napi::Array::New(env);
        uint32_t rateIdx = 0;
        auto addRate = [&](unsigned int rate) {
            for (uint32_t r = 0; r < rateIdx; ++r)
            {
                if (rates.Get(r).As<Napi::Number>().Uint32Value() == rate)
                    return;
            }
            rates.Set(rateIdx++, Napi::Number::New(env, rate));
        };

        IAudioClient *probeClient = nullptr;
        if (SUCCEEDED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void **)&probeClient)) && probeClient)
        {
            WAVEFORMATEX *probeMix = nullptr;
            if (SUCCEEDED(probeClient->GetMixFormat(&probeMix)) && probeMix)
            {
                obj.Set("mixSampleRate", Napi::Number::New(env, probeMix->nSamplesPerSec));
                obj.Set("mixChannels", Napi::Number::New(env, probeMix->nChannels));
                obj.Set("mixBitDepth", Napi::Number::New(env, probeMix->wBitsPerSample));
                obj.Set("mixSampleFormat", Napi::String::New(env, IsWasapiFloatFormat(probeMix) ? "f32le" : (probeMix->wBitsPerSample == 24 ? "s24le" : (probeMix->wBitsPerSample == 32 ? "s32le" : "s16le"))));
                addRate(static_cast<unsigned int>(probeMix->nSamplesPerSec));
                CoTaskMemFree(probeMix);
            }

            const unsigned int commonRates[] = {44100, 48000, 88200, 96000, 176400, 192000, 352800, 705600};
            const std::pair<unsigned int, bool> candidates[] = {{16, false}, {24, false}, {32, true}, {32, false}};
            for (unsigned int rate : commonRates)
            {
                bool supported = false;
                for (const auto &candidate : candidates)
                {
                    WAVEFORMATEXTENSIBLE probeFmt{};
                    BuildFormat(rate, 2, candidate.first, candidate.second, probeFmt);
                    if (probeClient->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &probeFmt.Format, nullptr) == S_OK)
                    {
                        supported = true;
                        break;
                    }
                }
                if (supported)
                    addRate(rate);
            }
            probeClient->Release();
        }

        if (rateIdx == 0)
        {
            addRate(44100);
            addRate(48000);
            addRate(96000);
        }
        obj.Set("sampleRates", rates);

        arr.Set(outIdx++, obj);

        CoTaskMemFree(id);
        dev->Release();
    }

    collection->Release();
    enumerator->Release();
    if (didCoInit)
        CoUninitialize();

    const auto asioDrivers = EnumerateAsioDrivers();
    for (const auto &driver : asioDrivers)
    {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("id", Napi::String::New(env, driver.id));
        obj.Set("name", Napi::String::New(env, "[ASIO] " + driver.name));
        obj.Set("api", Napi::String::New(env, "asio"));
        obj.Set("isDefault", Napi::Boolean::New(env, false));

        Napi::Array rates = Napi::Array::New(env);
        rates.Set(uint32_t(0), Napi::Number::New(env, 44100));
        rates.Set(uint32_t(1), Napi::Number::New(env, 48000));
        rates.Set(uint32_t(2), Napi::Number::New(env, 88200));
        rates.Set(uint32_t(3), Napi::Number::New(env, 96000));
        rates.Set(uint32_t(4), Napi::Number::New(env, 176400));
        rates.Set(uint32_t(5), Napi::Number::New(env, 192000));
        rates.Set(uint32_t(6), Napi::Number::New(env, 352800));
        rates.Set(uint32_t(7), Napi::Number::New(env, 705600));
        obj.Set("sampleRates", rates);

        Napi::Array bufferSizes = Napi::Array::New(env);
        bufferSizes.Set(uint32_t(0), Napi::Number::New(env, 32));
        bufferSizes.Set(uint32_t(1), Napi::Number::New(env, 64));
        bufferSizes.Set(uint32_t(2), Napi::Number::New(env, 128));
        bufferSizes.Set(uint32_t(3), Napi::Number::New(env, 256));
        bufferSizes.Set(uint32_t(4), Napi::Number::New(env, 512));
        bufferSizes.Set(uint32_t(5), Napi::Number::New(env, 1024));
        bufferSizes.Set(uint32_t(6), Napi::Number::New(env, 2048));
        obj.Set("bufferSizes", bufferSizes);

        arr.Set(outIdx++, obj);
    }

    return arr;
}

#endif // EXCLUSIVE_WIN32

#if defined(EXCLUSIVE_MACOS)

// Helper function to convert CFString to std::string
static std::string CFStringToStdString(CFStringRef cfStr)
{
    if (!cfStr)
        return "";

    const char *cstr = CFStringGetCStringPtr(cfStr, kCFStringEncodingUTF8);
    if (cstr)
        return std::string(cstr);

    CFIndex length = CFStringGetLength(cfStr);
    CFIndex maxSize = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
    std::vector<char> buffer(maxSize);

    if (CFStringGetCString(cfStr, buffer.data(), maxSize, kCFStringEncodingUTF8))
    {
        return std::string(buffer.data());
    }
    return "";
}

// Get all audio devices on macOS
static Napi::Array GetCoreAudioDevices(const Napi::Env &env)
{
    Napi::Array arr = Napi::Array::New(env);
    uint32_t outIdx = 0;

    // Get all audio devices
    AudioObjectPropertyAddress propAddress = {
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain};

    UInt32 dataSize = 0;
    OSStatus err = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject,
                                                  &propAddress,
                                                  0,
                                                  NULL,
                                                  &dataSize);
    if (err != noErr)
    {
        return arr;
    }

    UInt32 deviceCount = dataSize / sizeof(AudioDeviceID);
    std::vector<AudioDeviceID> devices(deviceCount);

    err = AudioObjectGetPropertyData(kAudioObjectSystemObject,
                                     &propAddress,
                                     0,
                                     NULL,
                                     &dataSize,
                                     devices.data());
    if (err != noErr)
    {
        return arr;
    }

    // Get default output device
    propAddress.mSelector = kAudioHardwarePropertyDefaultOutputDevice;
    AudioDeviceID defaultDevice = kAudioDeviceUnknown;
    dataSize = sizeof(defaultDevice);
    AudioObjectGetPropertyData(kAudioObjectSystemObject,
                               &propAddress,
                               0,
                               NULL,
                               &dataSize,
                               &defaultDevice);

    // Process each device
    for (UInt32 i = 0; i < deviceCount; i++)
    {
        AudioDeviceID deviceID = devices[i];

        // Check if this device has output streams
        propAddress.mSelector = kAudioDevicePropertyStreams;
        propAddress.mScope = kAudioDevicePropertyScopeOutput;
        dataSize = 0;

        err = AudioObjectGetPropertyDataSize(deviceID,
                                             &propAddress,
                                             0,
                                             NULL,
                                             &dataSize);
        if (err != noErr || dataSize == 0)
        {
            continue; // Skip devices with no output
        }

        // Get device UID
        propAddress.mSelector = kAudioDevicePropertyDeviceUID;
        CFStringRef deviceUID = NULL;
        dataSize = sizeof(deviceUID);
        err = AudioObjectGetPropertyData(deviceID,
                                         &propAddress,
                                         0,
                                         NULL,
                                         &dataSize,
                                         &deviceUID);
        if (err != noErr || !deviceUID)
        {
            continue;
        }

        // Get device name
        propAddress.mSelector = kAudioDevicePropertyDeviceNameCFString;
        CFStringRef deviceName = NULL;
        dataSize = sizeof(deviceName);
        err = AudioObjectGetPropertyData(deviceID,
                                         &propAddress,
                                         0,
                                         NULL,
                                         &dataSize,
                                         &deviceName);

        std::string uid = CFStringToStdString(deviceUID);
        std::string name = deviceName ? CFStringToStdString(deviceName) : "Unknown Device";

        if (deviceUID)
            CFRelease(deviceUID);
        if (deviceName)
            CFRelease(deviceName);

        if (uid.empty())
        {
            continue;
        }

        // Get supported sample rates
        propAddress.mSelector = kAudioDevicePropertyAvailableNominalSampleRates;
        dataSize = 0;
        err = AudioObjectGetPropertyDataSize(deviceID,
                                             &propAddress,
                                             0,
                                             NULL,
                                             &dataSize);

        std::vector<AudioValueRange> sampleRates;
        Napi::Array ratesArray = Napi::Array::New(env);
        uint32_t rateIdx = 0;

        if (err == noErr && dataSize > 0)
        {
            sampleRates.resize(dataSize / sizeof(AudioValueRange));
            err = AudioObjectGetPropertyData(deviceID,
                                             &propAddress,
                                             0,
                                             NULL,
                                             &dataSize,
                                             sampleRates.data());

            if (err == noErr)
            {
                // Add common sample rates within the supported range
                double commonRates[] = {44100.0, 48000.0, 88200.0, 96000.0, 176400.0, 192000.0};
                for (size_t j = 0; j < sizeof(commonRates) / sizeof(commonRates[0]); j++)
                {
                    bool supported = false;
                    for (const auto &range : sampleRates)
                    {
                        if (commonRates[j] >= range.mMinimum && commonRates[j] <= range.mMaximum)
                        {
                            supported = true;
                            break;
                        }
                    }
                    if (supported)
                    {
                        ratesArray.Set(rateIdx++, Napi::Number::New(env, commonRates[j]));
                    }
                }
            }
        }

        // If no specific rates found, add defaults
        if (rateIdx == 0)
        {
            ratesArray.Set((uint32_t)0, Napi::Number::New(env, 44100.0));
            ratesArray.Set((uint32_t)1, Napi::Number::New(env, 48000.0));
            ratesArray.Set((uint32_t)2, Napi::Number::New(env, 96000.0));
        }

        // Create device object
        Napi::Object deviceObj = Napi::Object::New(env);
        deviceObj.Set("id", Napi::String::New(env, uid));
        deviceObj.Set("name", Napi::String::New(env, name));
        deviceObj.Set("isDefault", Napi::Boolean::New(env, deviceID == defaultDevice));
        deviceObj.Set("sampleRates", ratesArray);

        arr.Set(outIdx++, deviceObj);
    }

    return arr;
}

// Try to set the requested format on macOS
static bool TrySetFormat(AudioUnit audioUnit,
                         unsigned int sampleRate,
                         unsigned int channels,
                         unsigned int bitDepth,
                         bool isFloat)
{
    AudioStreamBasicDescription asbd = {0};
    asbd.mSampleRate = sampleRate;
    asbd.mFormatID = kAudioFormatLinearPCM;

    if (isFloat)
    {
        asbd.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    }
    else
    {
        asbd.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
    }

    if (bitDepth > 8)
    {
        asbd.mFormatFlags |= kAudioFormatFlagIsAlignedHigh;
    }

    asbd.mBitsPerChannel = bitDepth;
    asbd.mChannelsPerFrame = channels;
    asbd.mBytesPerFrame = (bitDepth / 8) * channels;
    asbd.mFramesPerPacket = 1;
    asbd.mBytesPerPacket = asbd.mBytesPerFrame * asbd.mFramesPerPacket;

    OSStatus err = AudioUnitSetProperty(audioUnit,
                                        kAudioUnitProperty_StreamFormat,
                                        kAudioUnitScope_Input,
                                        0,
                                        &asbd,
                                        sizeof(asbd));

    return err == noErr;
}

// CoreAudio render callback
static OSStatus CoreAudioRenderCallback(void *inRefCon,
                                        AudioUnitRenderActionFlags *ioActionFlags,
                                        const AudioTimeStamp *inTimeStamp,
                                        UInt32 inBusNumber,
                                        UInt32 inNumberFrames,
                                        AudioBufferList *ioData)
{
    (void)ioActionFlags;
    (void)inTimeStamp;
    (void)inBusNumber;

    OutputStreamState *s = static_cast<OutputStreamState *>(inRefCon);
    if (!s || !s->running.load())
    {
        // Fill with silence
        for (UInt32 i = 0; i < ioData->mNumberBuffers; ++i)
        {
            std::memset(ioData->mBuffers[i].mData, 0, ioData->mBuffers[i].mDataByteSize);
        }
        return noErr;
    }

    const size_t requestedBytes = static_cast<size_t>(inNumberFrames) * s->bytesPerFrame;
    // Track recent hardware callback size for approximate latency reporting
    s->lastHardwarePaddingFrames.store(inNumberFrames);

    if (s->paused.load())
    {
        // Fill with silence when paused
        for (UInt32 i = 0; i < ioData->mNumberBuffers; ++i)
        {
            std::memset(ioData->mBuffers[i].mData, 0, ioData->mBuffers[i].mDataByteSize);
        }
        s->ringCv.notify_all();
        return noErr;
    }

    // For interleaved audio (most common on macOS)
    if (ioData->mNumberBuffers == 1)
    {
        uint8_t *outputBuffer = static_cast<uint8_t *>(ioData->mBuffers[0].mData);
        size_t bytesFromRing = 0;
        // Lock-free SPSC read by audio thread
        bytesFromRing = s->ring.read(outputBuffer, requestedBytes);

        if (bytesFromRing < requestedBytes)
        {
            std::memset(outputBuffer + bytesFromRing, 0, requestedBytes - bytesFromRing);
        }

        ioData->mBuffers[0].mDataByteSize = static_cast<UInt32>(requestedBytes);
    }
    // For non-interleaved audio (less common)
    else
    {
        std::vector<uint8_t> interleaved(requestedBytes);
        size_t bytesFromRing = 0;

        // Lock-free SPSC read
        bytesFromRing = s->ring.read(interleaved.data(), requestedBytes);

        if (bytesFromRing < requestedBytes)
        {
            std::memset(interleaved.data() + bytesFromRing, 0, requestedBytes - bytesFromRing);
        }

        // Deinterleave: guard against mNumberBuffers != s->channels mismatch
        const UInt32 numBufs = ioData->mNumberBuffers;
        const UInt32 bytesPerSample = s->bitDepth / 8;
        const UInt32 bytesPerChannel = inNumberFrames * bytesPerSample;
        for (UInt32 i = 0; i < numBufs; ++i)
        {
            uint8_t *channelBuffer = static_cast<uint8_t *>(ioData->mBuffers[i].mData);
            if (!channelBuffer)
                continue;

            for (UInt32 frame = 0; frame < inNumberFrames; ++frame)
            {
                // Source channel index clamped to available channels
                const UInt32 srcCh = (i < s->channels) ? i : (s->channels - 1);
                size_t srcOffset = static_cast<size_t>(frame) * s->bytesPerFrame
                                 + static_cast<size_t>(srcCh) * bytesPerSample;
                size_t dstOffset = static_cast<size_t>(frame) * bytesPerSample;

                if (srcOffset + bytesPerSample <= interleaved.size())
                    std::memcpy(channelBuffer + dstOffset, interleaved.data() + srcOffset, bytesPerSample);
                else
                    std::memset(channelBuffer + dstOffset, 0, bytesPerSample);
            }

            ioData->mBuffers[i].mDataByteSize = bytesPerChannel;
        }
    }

    s->ringCv.notify_all();
    return noErr;
}

// Initialize CoreAudio with device selection and format negotiation
static bool InitCoreAudio(OutputStreamState *s,
                          const std::string &deviceId,
                          bool exclusive,
                          double bufferMs,
                          bool bitPerfect)
{
    if (!s)
        return false;

    SetLastErrStr("");

    AudioComponentDescription desc = {0};
    desc.componentType = kAudioUnitType_Output;
    desc.componentSubType = kAudioUnitSubType_HALOutput; // Use HAL for device selection
    desc.componentManufacturer = kAudioUnitManufacturer_Apple;
    desc.componentFlags = 0;
    desc.componentFlagsMask = 0;

    AudioComponent comp = AudioComponentFindNext(NULL, &desc);
    if (!comp)
    {
        SetLastErrStr("AudioComponentFindNext failed");
        return false;
    }

    AudioComponentInstance audioUnit = NULL;
    OSStatus err = AudioComponentInstanceNew(comp, &audioUnit);
    if (err != noErr || !audioUnit)
    {
        SetLastErrStr("AudioComponentInstanceNew failed");
        return false;
    }

    // Enable output
    UInt32 enableIO = 1;
    err = AudioUnitSetProperty(audioUnit,
                               kAudioOutputUnitProperty_EnableIO,
                               kAudioUnitScope_Output,
                               0,
                               &enableIO,
                               sizeof(enableIO));
    if (err != noErr)
    {
        AudioComponentInstanceDispose(audioUnit);
        SetLastErrStr("Failed to enable output");
        return false;
    }

    // Disable input
    enableIO = 0;
    err = AudioUnitSetProperty(audioUnit,
                               kAudioOutputUnitProperty_EnableIO,
                               kAudioUnitScope_Input,
                               1,
                               &enableIO,
                               sizeof(enableIO));
    if (err != noErr)
    {
        AudioComponentInstanceDispose(audioUnit);
        SetLastErrStr("Failed to disable input");
        return false;
    }

    // Select specific device if requested
    if (!deviceId.empty() && deviceId != "default")
    {
        AudioDeviceID targetDevice = kAudioDeviceUnknown;

        // Find device by UID
        AudioObjectPropertyAddress propAddress = {
            kAudioHardwarePropertyDevices,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain};

        UInt32 dataSize = 0;
        err = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject,
                                             &propAddress,
                                             0,
                                             NULL,
                                             &dataSize);
        if (err == noErr)
        {
            UInt32 deviceCount = dataSize / sizeof(AudioDeviceID);
            std::vector<AudioDeviceID> devices(deviceCount);

            err = AudioObjectGetPropertyData(kAudioObjectSystemObject,
                                             &propAddress,
                                             0,
                                             NULL,
                                             &dataSize,
                                             devices.data());

            if (err == noErr)
            {
                for (UInt32 i = 0; i < deviceCount; i++)
                {
                    propAddress.mSelector = kAudioDevicePropertyDeviceUID;
                    CFStringRef deviceUID = NULL;
                    dataSize = sizeof(deviceUID);

                    err = AudioObjectGetPropertyData(devices[i],
                                                     &propAddress,
                                                     0,
                                                     NULL,
                                                     &dataSize,
                                                     &deviceUID);

                    if (err == noErr && deviceUID)
                    {
                        std::string uid = CFStringToStdString(deviceUID);
                        CFRelease(deviceUID);

                        if (uid == deviceId)
                        {
                            targetDevice = devices[i];
                            break;
                        }
                    }
                }
            }
        }

        if (targetDevice != kAudioDeviceUnknown)
        {
            err = AudioUnitSetProperty(audioUnit,
                                       kAudioOutputUnitProperty_CurrentDevice,
                                       kAudioUnitScope_Global,
                                       0,
                                       &targetDevice,
                                       sizeof(targetDevice));
            if (err != noErr)
            {
                AudioComponentInstanceDispose(audioUnit);
                SetLastErrStr("Failed to set output device");
                return false;
            }
            // If exclusive requested, try to claim Hog Mode for the device
            if (exclusive)
            {
                AudioObjectPropertyAddress hogAddr = {
                    kAudioDevicePropertyHogMode,
                    kAudioObjectPropertyScopeGlobal,
                    kAudioObjectPropertyElementMain};
                pid_t pid = getpid();
                OSStatus hres = AudioObjectSetPropertyData(targetDevice,
                                                           &hogAddr,
                                                           0,
                                                           NULL,
                                                           sizeof(pid),
                                                           &pid);
                if (hres == noErr)
                {
                    DBG("InitCoreAudio: Hog Mode enabled for device");
                }
                else
                {
                    DBG("InitCoreAudio: Hog Mode request failed (continuing)");
                }
            }
        }
        else
        {
            // Device not found, fall back to default
        }
    }

    // Try to set the requested format
    bool formatSet = false;

    if (exclusive)
    {
        // Try different formats in order of preference
        std::vector<std::pair<unsigned int, bool>> candidates;

        if (s->bitDepth == 32)
        {
            if (bitPerfect)
            {
                candidates.push_back({32, true});  // Float32
                candidates.push_back({32, false}); // Int32
            }
            else
            {
                candidates.push_back({32, true});  // Float32
                candidates.push_back({32, false}); // Int32
                candidates.push_back({24, false}); // Int24
                candidates.push_back({16, false}); // Int16
            }
        }
        else if (s->bitDepth == 24)
        {
            if (bitPerfect)
            {
                candidates.push_back({24, false}); // Int24
            }
            else
            {
                candidates.push_back({24, false}); // Int24
                candidates.push_back({32, true});  // Float32
                candidates.push_back({32, false}); // Int32
                candidates.push_back({16, false}); // Int16
            }
        }
        else if (s->bitDepth == 16)
        {
            if (bitPerfect)
            {
                candidates.push_back({16, false}); // Int16
            }
            else
            {
                candidates.push_back({16, false}); // Int16
                candidates.push_back({32, true});  // Float32
                candidates.push_back({24, false}); // Int24
            }
        }

        for (const auto &candidate : candidates)
        {
            if (TrySetFormat(audioUnit, s->sampleRate, s->channels,
                             candidate.first, candidate.second))
            {
                s->bitDepth = candidate.first;
                s->sampleFormatFloat = candidate.second;
                formatSet = true;
                break;
            }
        }
    }

    // If exclusive mode failed or not requested, try to get the default format
    if (!formatSet)
    {
        // Get current format to see what's supported
        AudioStreamBasicDescription currentASBD = {0};
        UInt32 dataSize = sizeof(currentASBD);

        err = AudioUnitGetProperty(audioUnit,
                                   kAudioUnitProperty_StreamFormat,
                                   kAudioUnitScope_Input,
                                   0,
                                   &currentASBD,
                                   &dataSize);

        if (err == noErr)
        {
            s->sampleRate = currentASBD.mSampleRate;
            s->channels = currentASBD.mChannelsPerFrame;
            s->bitDepth = currentASBD.mBitsPerChannel;
            s->sampleFormatFloat = (currentASBD.mFormatFlags & kAudioFormatFlagIsFloat) != 0;

            // Try to match requested sample rate if possible
            if (currentASBD.mSampleRate != s->sampleRate)
            {
                // Try to set the requested rate
                currentASBD.mSampleRate = s->sampleRate;
                err = AudioUnitSetProperty(audioUnit,
                                           kAudioUnitProperty_StreamFormat,
                                           kAudioUnitScope_Input,
                                           0,
                                           &currentASBD,
                                           sizeof(currentASBD));

                if (err != noErr)
                {
                    // Revert to actual sample rate
                    err = AudioUnitGetProperty(audioUnit,
                                               kAudioUnitProperty_StreamFormat,
                                               kAudioUnitScope_Input,
                                               0,
                                               &currentASBD,
                                               &dataSize);
                    if (err == noErr)
                    {
                        s->sampleRate = currentASBD.mSampleRate;
                    }
                }
            }
        }
    }

    s->bytesPerFrame = (s->bitDepth / 8) * s->channels;

    // Set up render callback
    AURenderCallbackStruct renderCallback = {0};
    renderCallback.inputProc = CoreAudioRenderCallback;
    renderCallback.inputProcRefCon = s;

    err = AudioUnitSetProperty(audioUnit,
                               kAudioUnitProperty_SetRenderCallback,
                               kAudioUnitScope_Input,
                               0,
                               &renderCallback,
                               sizeof(renderCallback));
    if (err != noErr)
    {
        AudioComponentInstanceDispose(audioUnit);
        SetLastErrStr("Failed to set render callback");
        return false;
    }

    // Initialize audio unit
    err = AudioUnitInitialize(audioUnit);
    if (err != noErr)
    {
        AudioComponentInstanceDispose(audioUnit);
        SetLastErrStr("AudioUnitInitialize failed");
        return false;
    }

    // Configure ring buffer
    if (bufferMs < 20.0)
        bufferMs = 20.0;
    if (bufferMs > 2000.0)
        bufferMs = 2000.0;

    double ringFramesD = (static_cast<double>(s->sampleRate) * bufferMs) / 1000.0;
    // Ensure at least 2 periods of audio
    double minFrames = static_cast<double>(s->sampleRate) / 50.0; // 20ms
    if (ringFramesD < minFrames)
    {
        ringFramesD = minFrames;
    }

    size_t ringFrames = static_cast<size_t>(ringFramesD);
    size_t ringBytes = ringFrames * s->bytesPerFrame;

    s->ring.init(ringBytes);
    s->ringDurationMs = static_cast<double>(ringFrames) * 1000.0 / static_cast<double>(s->sampleRate);

    // Start audio unit
    err = AudioOutputUnitStart(audioUnit);
    if (err != noErr)
    {
        AudioUnitUninitialize(audioUnit);
        AudioComponentInstanceDispose(audioUnit);
        SetLastErrStr("AudioOutputUnitStart failed");
        return false;
    }

    s->audioUnit = audioUnit;
    s->open.store(true);
    s->running.store(true);

    return true;
}

static int WriteCoreAudio(OutputStreamState *s,
                          const uint8_t *data,
                          size_t len,
                          bool blocking)
{
    if (!s || !s->open.load())
        return -1;
    if (!data || len == 0)
        return 0;

    uint32_t timeoutMs = blocking ? 2000u : 0u;
    size_t written = WriteToRingBlocking(s, data, len, timeoutMs);
    return static_cast<int>(written);
}

static void CloseCoreAudio(OutputStreamState *s)
{
    if (!s)
        return;

    s->running.store(false);
    s->open.store(false);
    s->ringCv.notify_all();

    if (s->audioUnit)
    {
        AudioOutputUnitStop(s->audioUnit);
        AudioUnitUninitialize(s->audioUnit);
        AudioComponentInstanceDispose(s->audioUnit);
        s->audioUnit = nullptr;
    }
}

#endif // EXCLUSIVE_MACOS

#if defined(EXCLUSIVE_LINUX)

// Convert ALSA sample format to bit depth
static unsigned int AlsaFormatToBitDepth(snd_pcm_format_t format)
{
    switch (format)
    {
    case SND_PCM_FORMAT_S16_LE:
    case SND_PCM_FORMAT_S16_BE:
        return 16;
    case SND_PCM_FORMAT_S24_LE:
    case SND_PCM_FORMAT_S24_BE:
    case SND_PCM_FORMAT_S24_3LE:
    case SND_PCM_FORMAT_S24_3BE:
        return 24;
    case SND_PCM_FORMAT_S32_LE:
    case SND_PCM_FORMAT_S32_BE:
        return 32;
    case SND_PCM_FORMAT_FLOAT_LE:
    case SND_PCM_FORMAT_FLOAT_BE:
        return 32; // Float32
    default:
        return 16;
    }
}

static bool AlsaFormatIsFloat(snd_pcm_format_t format)
{
    return format == SND_PCM_FORMAT_FLOAT_LE || format == SND_PCM_FORMAT_FLOAT_BE;
}

// Convert bit depth to ALSA sample format
static snd_pcm_format_t BitDepthToAlsaFormat(unsigned int bitDepth, bool isFloat)
{
    if (isFloat && bitDepth == 32)
    {
        return SND_PCM_FORMAT_FLOAT_LE;
    }

    switch (bitDepth)
    {
    case 16:
        return SND_PCM_FORMAT_S16_LE;
    case 24:
        return SND_PCM_FORMAT_S24_LE;
    case 32:
        return SND_PCM_FORMAT_S32_LE;
    default:
        return SND_PCM_FORMAT_S16_LE;
    }
}

// Try to set hardware parameters
static bool TrySetAlsaParams(snd_pcm_t *pcm,
                             OutputStreamState *s,
                             bool exclusive,
                             bool bitPerfect)
{
    int err;
    snd_pcm_hw_params_t *hwParams = nullptr;

    // Allocate hardware parameters structure
    snd_pcm_hw_params_alloca(&hwParams);

    // Fill it in with default values
    err = snd_pcm_hw_params_any(pcm, hwParams);
    if (err < 0)
    {
        SetLastErrorAlsa("Cannot initialize hardware parameters", err);
        return false;
    }

    // Set access type (exclusive or shared)
    snd_pcm_access_t access = exclusive ? SND_PCM_ACCESS_RW_INTERLEAVED : SND_PCM_ACCESS_RW_INTERLEAVED;
    err = snd_pcm_hw_params_set_access(pcm, hwParams, access);
    if (err < 0)
    {
        if (exclusive)
        {
            // Try shared mode if exclusive fails
            access = SND_PCM_ACCESS_RW_INTERLEAVED;
            err = snd_pcm_hw_params_set_access(pcm, hwParams, access);
            if (err < 0)
            {
                SetLastErrorAlsa("Cannot set access type", err);
                return false;
            }
        }
        else
        {
            SetLastErrorAlsa("Cannot set access type", err);
            return false;
        }
    }

    // Try different formats
    bool formatSet = false;

    if (exclusive)
    {
        // Try different formats in order of preference
        std::vector<std::pair<unsigned int, bool>> candidates;

        if (s->bitDepth == 32)
        {
            if (bitPerfect)
            {
                candidates.push_back({32, true});  // Float32
                candidates.push_back({32, false}); // Int32
            }
            else
            {
                candidates.push_back({32, true});  // Float32
                candidates.push_back({32, false}); // Int32
                candidates.push_back({24, false}); // Int24
                candidates.push_back({16, false}); // Int16
            }
        }
        else if (s->bitDepth == 24)
        {
            if (bitPerfect)
            {
                candidates.push_back({24, false}); // Int24
            }
            else
            {
                candidates.push_back({24, false}); // Int24
                candidates.push_back({32, true});  // Float32
                candidates.push_back({32, false}); // Int32
                candidates.push_back({16, false}); // Int16
            }
        }
        else if (s->bitDepth == 16)
        {
            if (bitPerfect)
            {
                candidates.push_back({16, false}); // Int16
            }
            else
            {
                candidates.push_back({16, false}); // Int16
                candidates.push_back({32, true});  // Float32
                candidates.push_back({24, false}); // Int24
            }
        }

        for (const auto &candidate : candidates)
        {
            snd_pcm_format_t format = BitDepthToAlsaFormat(candidate.first, candidate.second);
            err = snd_pcm_hw_params_set_format(pcm, hwParams, format);
            if (err >= 0)
            {
                s->bitDepth = candidate.first;
                s->sampleFormatFloat = candidate.second;
                formatSet = true;
                break;
            }
        }
    }

    // If exclusive mode failed or not requested, try to get a supported format
    if (!formatSet)
    {
        // Get first supported format
        snd_pcm_format_t format;
        err = snd_pcm_hw_params_get_format(hwParams, &format);
        if (err >= 0)
        {
            s->bitDepth = AlsaFormatToBitDepth(format);
            s->sampleFormatFloat = AlsaFormatIsFloat(format);
        }
        else
        {
            // Default to S16_LE
            err = snd_pcm_hw_params_set_format(pcm, hwParams, SND_PCM_FORMAT_S16_LE);
            if (err < 0)
            {
                SetLastErrorAlsa("Cannot set sample format", err);
                return false;
            }
            s->bitDepth = 16;
            s->sampleFormatFloat = false;
        }
    }

    // Set channels
    err = snd_pcm_hw_params_set_channels(pcm, hwParams, s->channels);
    if (err < 0)
    {
        // Try to get supported channels
        unsigned int minCh, maxCh;
        err = snd_pcm_hw_params_get_channels_min(hwParams, &minCh);
        if (err >= 0)
        {
            err = snd_pcm_hw_params_get_channels_max(hwParams, &maxCh);
            if (err >= 0 && s->channels >= minCh && s->channels <= maxCh)
            {
                // Try exact number
                err = snd_pcm_hw_params_set_channels(pcm, hwParams, s->channels);
            }
        }
        if (err < 0)
        {
            // Set to 2 channels (stereo) as fallback
            err = snd_pcm_hw_params_set_channels(pcm, hwParams, 2);
            if (err < 0)
            {
                SetLastErrorAlsa("Cannot set channels", err);
                return false;
            }
            s->channels = 2;
        }
    }

    // Set sample rate
    unsigned int actualRate = s->sampleRate;
    err = snd_pcm_hw_params_set_rate_near(pcm, hwParams, &actualRate, 0);
    if (err < 0)
    {
        SetLastErrorAlsa("Cannot set sample rate", err);
        return false;
    }
    s->sampleRate = actualRate;

    // Set buffer size based on latency
    snd_pcm_uframes_t bufferSize = (s->sampleRate * 100) / 1000; // 100ms default
    snd_pcm_uframes_t periodSize = bufferSize / 4;               // 4 periods per buffer

    err = snd_pcm_hw_params_set_buffer_size_near(pcm, hwParams, &bufferSize);
    if (err < 0)
    {
        SetLastErrorAlsa("Cannot set buffer size", err);
        return false;
    }

    err = snd_pcm_hw_params_set_period_size_near(pcm, hwParams, &periodSize, 0);
    if (err < 0)
    {
        SetLastErrorAlsa("Cannot set period size", err);
        return false;
    }

    // Apply hardware parameters
    err = snd_pcm_hw_params(pcm, hwParams);
    if (err < 0)
    {
        SetLastErrorAlsa("Cannot set hardware parameters", err);
        return false;
    }

    // Get actual buffer and period size
    snd_pcm_hw_params_get_buffer_size(hwParams, &s->bufferSize);
    snd_pcm_hw_params_get_period_size(hwParams, &s->periodSize, 0);

    s->bytesPerFrame = (s->bitDepth / 8) * s->channels;

    return true;
}

// ALSA render thread
static void AlsaRenderThread(OutputStreamState *s)
{
    if (!s || !s->pcmHandle)
    {
        return;
    }

    s->running.store(true);

    std::vector<uint8_t> tempBuffer(s->periodSize * s->bytesPerFrame);

    while (s->running.load())
    {
        if (s->paused.load())
        {
            // Try hardware pause first; fall back to writing silence.
            int pauseErr = snd_pcm_pause(s->pcmHandle, 1);
            if (pauseErr == 0)
            {
                // Wait until unpaused or stopped
                while (s->running.load() && s->paused.load())
                    std::this_thread::sleep_for(std::chrono::milliseconds(5));
                snd_pcm_pause(s->pcmHandle, 0);
            }
            else
            {
                // Device does not support pause; write silence for this period
                std::memset(tempBuffer.data(), 0, tempBuffer.size());
                int err = snd_pcm_writei(s->pcmHandle, tempBuffer.data(), s->periodSize);
                if (err == -EPIPE)
                    snd_pcm_prepare(s->pcmHandle);
                else if (err < 0)
                {
                    SetLastErrorAlsa("Write error (paused silence)", err);
                    break;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
            continue;
        }

        size_t bytesToRead = s->periodSize * s->bytesPerFrame;
        size_t bytesRead = s->ring.read(tempBuffer.data(), bytesToRead);

        if (bytesRead < bytesToRead)
            std::memset(tempBuffer.data() + bytesRead, 0, bytesToRead - bytesRead);

        // Write loop: retry on short writes so no pulled bytes are lost
        snd_pcm_sframes_t framesToWrite = static_cast<snd_pcm_sframes_t>(bytesToRead / s->bytesPerFrame);
        snd_pcm_sframes_t totalWritten = 0;
        while (totalWritten < framesToWrite && s->running.load())
        {
            snd_pcm_sframes_t framesWritten = snd_pcm_writei(
                s->pcmHandle,
                tempBuffer.data() + static_cast<size_t>(totalWritten) * s->bytesPerFrame,
                static_cast<snd_pcm_uframes_t>(framesToWrite - totalWritten));

            if (framesWritten == -EPIPE)
            {
                int err = snd_pcm_prepare(s->pcmHandle);
                if (err < 0)
                {
                    SetLastErrorAlsa("Cannot recover from underrun", err);
                    goto thread_exit;
                }
                // Retry same position after xrun recovery
            }
            else if (framesWritten < 0)
            {
                SetLastErrorAlsa("Write error", static_cast<int>(framesWritten));
                goto thread_exit;
            }
            else
            {
                totalWritten += framesWritten;
            }
        }

        // Update hardware latency stats
        {
            snd_pcm_sframes_t delayFrames = 0;
            if (snd_pcm_delay(s->pcmHandle, &delayFrames) == 0 && delayFrames >= 0)
                s->lastHardwarePaddingFrames.store(static_cast<uint32_t>(delayFrames));
        }
        s->ringCv.notify_all();
    }
    thread_exit:;

    s->running.store(false);
}

// Initialize ALSA
static bool InitAlsa(OutputStreamState *s,
                     const std::string &deviceId,
                     bool exclusive,
                     double bufferMs,
                     bool bitPerfect)
{
    if (!s)
        return false;

    SetLastErrStr("");

    // Default ALSA device if none specified
    const char *device = deviceId.empty() ? "default" : deviceId.c_str();

    // Open PCM device
    snd_pcm_t *pcm = nullptr;
    int err = snd_pcm_open(&pcm, device, SND_PCM_STREAM_PLAYBACK, 0);
    if (err < 0)
    {
        SetLastErrorAlsa("Cannot open audio device", err);
        return false;
    }

    // Try to set hardware parameters
    if (!TrySetAlsaParams(pcm, s, exclusive, bitPerfect))
    {
        snd_pcm_close(pcm);
        return false;
    }

    // Configure ring buffer
    if (bufferMs < 20.0)
        bufferMs = 20.0;
    if (bufferMs > 2000.0)
        bufferMs = 2000.0;

    double ringFramesD = (static_cast<double>(s->sampleRate) * bufferMs) / 1000.0;
    // Ensure at least 4 periods
    if (ringFramesD < static_cast<double>(s->periodSize) * 4)
    {
        ringFramesD = static_cast<double>(s->periodSize) * 4;
    }

    size_t ringFrames = static_cast<size_t>(ringFramesD);
    size_t ringBytes = ringFrames * s->bytesPerFrame;

    s->ring.init(ringBytes);
    s->ringDurationMs = static_cast<double>(ringFrames) * 1000.0 / static_cast<double>(s->sampleRate);

    // Start playback
    err = snd_pcm_prepare(pcm);
    if (err < 0)
    {
        snd_pcm_close(pcm);
        SetLastErrorAlsa("Cannot prepare audio interface", err);
        return false;
    }

    s->pcmHandle = pcm;
    s->open.store(true);

    // Start render thread
    s->renderThread = std::thread(AlsaRenderThread, s);

    return true;
}

static int WriteAlsa(OutputStreamState *s,
                     const uint8_t *data,
                     size_t len,
                     bool blocking)
{
    if (!s || !s->open.load())
        return -1;
    if (!data || len == 0)
        return 0;

    uint32_t timeoutMs = blocking ? 2000u : 0u;
    size_t written = WriteToRingBlocking(s, data, len, timeoutMs);
    return static_cast<int>(written);
}

static void CloseAlsa(OutputStreamState *s)
{
    if (!s)
        return;

    s->running.store(false);
    s->open.store(false);
    s->ringCv.notify_all();

    if (s->renderThread.joinable())
    {
        s->renderThread.join();
    }

    if (s->pcmHandle)
    {
        snd_pcm_drain(s->pcmHandle); // Drain remaining samples
        snd_pcm_close(s->pcmHandle);
        s->pcmHandle = nullptr;
    }
}

static Napi::Array GetAlsaDevices(const Napi::Env &env)
{
    Napi::Array arr = Napi::Array::New(env);
    uint32_t outIdx = 0;

    // Add default device
    Napi::Object defaultDev = Napi::Object::New(env);
    defaultDev.Set("id", Napi::String::New(env, "default"));
    defaultDev.Set("name", Napi::String::New(env, "Default ALSA Device"));
    defaultDev.Set("isDefault", Napi::Boolean::New(env, true));

    Napi::Array rates = Napi::Array::New(env);
    rates.Set(uint32_t(0), Napi::Number::New(env, 44100));
    rates.Set(uint32_t(1), Napi::Number::New(env, 48000));
    rates.Set(uint32_t(2), Napi::Number::New(env, 96000));
    defaultDev.Set("sampleRates", rates);

    arr.Set(outIdx++, defaultDev);

    // Try to enumerate ALSA devices
    // Note: This is a simplified enumeration. Real ALSA enumeration is more complex.
    void **hints = nullptr;
    int err = snd_device_name_hint(-1, "pcm", &hints);
    if (err == 0 && hints)
    {
        for (void **hint = hints; *hint != nullptr; hint++)
        {
            char *name = snd_device_name_get_hint(*hint, "NAME");
            char *desc = snd_device_name_get_hint(*hint, "DESC");
            char *ioid = snd_device_name_get_hint(*hint, "IOID");

            if (name && (ioid == nullptr || strcmp(ioid, "Output") == 0))
            {
                std::string deviceName = name;
                std::string deviceDesc = desc ? desc : name;

                // Skip duplicates and "null" device
                if (deviceName != "default" && deviceName.find("null") == std::string::npos)
                {
                    Napi::Object dev = Napi::Object::New(env);
                    dev.Set("id", Napi::String::New(env, deviceName));
                    dev.Set("name", Napi::String::New(env, deviceDesc));
                    dev.Set("isDefault", Napi::Boolean::New(env, false));

                    Napi::Array devRates = Napi::Array::New(env);
                    devRates.Set((uint32_t)0, Napi::Number::New(env, 44100));
                    devRates.Set((uint32_t)1, Napi::Number::New(env, 48000));
                    devRates.Set((uint32_t)2, Napi::Number::New(env, 96000));
                    dev.Set("sampleRates", devRates);
                    arr.Set(outIdx++, dev);
                }
            }

            if (name)
                free(name);
            if (desc)
                free(desc);
            if (ioid)
                free(ioid);
        }
        snd_device_name_free_hint(hints);
    }

    return arr;
}

#endif // EXCLUSIVE_LINUX

//
// N-API exports
//

static const char *SampleFormatName(const OutputStreamState *s)
{
    if (!s)
        return "s16le";
    if (s->nativeDsd)
        return "dsd8";
    if (s->sampleFormatFloat && s->bitDepth == 32)
        return "f32le";

    switch (s->bitDepth)
    {
    case 32:
        return "s32le";
    case 24:
        return "s24le";
    case 16:
        return "s16le";
    default:
        return "s16le";
    }
}

static Napi::Value OpenOutput(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject())
    {
        ThrowTypeError(env, "openOutput(options) requires an options object");
        return env.Null();
    }

    Napi::Object opts = info[0].As<Napi::Object>();

    std::string deviceId;
    if (opts.Has("deviceId") && opts.Get("deviceId").IsString())
    {
        deviceId = opts.Get("deviceId").As<Napi::String>().Utf8Value();
    }

    unsigned int sampleRate = 44100;
    unsigned int channels = 2;
    unsigned int bitDepth = 16;

    if (opts.Has("sampleRate"))
    {
        sampleRate = opts.Get("sampleRate").As<Napi::Number>().Uint32Value();
    }
    if (opts.Has("channels"))
    {
        channels = opts.Get("channels").As<Napi::Number>().Uint32Value();
    }
    if (opts.Has("bitDepth"))
    {
        bitDepth = opts.Get("bitDepth").As<Napi::Number>().Uint32Value();
    }

#if defined(EXCLUSIVE_WIN32)
    HWND windowHandle = nullptr;
    if (opts.Has("windowHandle") && opts.Get("windowHandle").IsBuffer())
    {
        auto buf = opts.Get("windowHandle").As<Napi::Buffer<uint8_t>>();
        uintptr_t raw = 0;
        const size_t copyLen = std::min(buf.Length(), sizeof(raw));
        if (copyLen > 0)
            std::memcpy(&raw, buf.Data(), copyLen);
        windowHandle = reinterpret_cast<HWND>(raw);
    }
#endif

    std::string mode = "exclusive";
    if (opts.Has("mode") && opts.Get("mode").IsString())
    {
        mode = opts.Get("mode").As<Napi::String>().Utf8Value();
    }

    double bufferMs = 250.0;
    if (opts.Has("bufferMs") && opts.Get("bufferMs").IsNumber())
    {
        bufferMs = opts.Get("bufferMs").As<Napi::Number>().DoubleValue();
    }

    long bufferFrames = 0;
    if (opts.Has("bufferFrames") && opts.Get("bufferFrames").IsNumber())
    {
        bufferFrames = opts.Get("bufferFrames").As<Napi::Number>().Int64Value();
        if (bufferFrames < 0)
            bufferFrames = 0;
    }

    bool bitPerfect = false;
    if (opts.Has("bitPerfect") && opts.Get("bitPerfect").IsBoolean())
    {
        bitPerfect = opts.Get("bitPerfect").As<Napi::Boolean>().Value();
    }

    bool strictBitPerfect = false;
    if (opts.Has("strictBitPerfect") && opts.Get("strictBitPerfect").IsBoolean())
    {
        strictBitPerfect = opts.Get("strictBitPerfect").As<Napi::Boolean>().Value();
    }

    bool dsdNative = false;
    if (opts.Has("dsdNative") && opts.Get("dsdNative").IsBoolean())
    {
        dsdNative = opts.Get("dsdNative").As<Napi::Boolean>().Value();
    }

    auto *s = new OutputStreamState();
    s->sampleRate = sampleRate;
    s->channels = channels;
    s->bitDepth = bitDepth;
    s->bytesPerFrame = (bitDepth / 8) * channels;

    bool ok = false;

#if defined(EXCLUSIVE_WIN32)

    if (mode == "asio")
    {
        ok = InitAsio(s, deviceId, windowHandle, bufferMs, bufferFrames, bitPerfect, dsdNative);
        if (!ok)
        {
            delete s;
            ThrowTypeError(env, "Failed to open ASIO output");
            return env.Null();
        }
    }
    else if (mode == "shared")
    {
        ok = InitWasapi(s, deviceId, false, bufferMs, bitPerfect);
        if (!ok)
        {
            delete s;
            ThrowTypeError(env, "Failed to open shared WASAPI output");
            return env.Null();
        }
    }
    else if (mode == "exclusive")
    {
        ok = InitWasapi(s, deviceId, true, bufferMs, bitPerfect);
        if (!ok)
        {
            std::string exclusiveFailure = GetLastErrStr();
            if (strictBitPerfect)
            {
                delete s;
                ThrowTypeError(env, "Exclusive format not supported in strict bitPerfect mode");
                return env.Null();
            }

            // Try shared fallback
            ok = InitWasapi(s, deviceId, false, bufferMs, bitPerfect);
            if (!ok)
            {
                delete s;
                ThrowTypeError(env, "Failed to open exclusive output; shared fallback also failed");
                return env.Null();
            }
            s->fallbackUsed = true;
            s->fallbackReason = exclusiveFailure.empty() ? "Exclusive output was rejected; opened shared WASAPI instead" : exclusiveFailure;
        }
    }
    else
    {
        delete s;
        ThrowTypeError(env, "Unknown mode; expected 'exclusive', 'shared', or 'asio'");
        return env.Null();
    }

#elif defined(EXCLUSIVE_MACOS)

    bool exclusive = (mode == "exclusive");

    ok = InitCoreAudio(s, deviceId, exclusive, bufferMs, bitPerfect);
    if (!ok)
    {
        if (strictBitPerfect && exclusive)
        {
            delete s;
            ThrowTypeError(env, "Exclusive format not supported in strict bitPerfect mode");
            return env.Null();
        }

        // Try without exclusive mode as fallback
        ok = InitCoreAudio(s, deviceId, false, bufferMs, false);
        if (!ok)
        {
            delete s;
            ThrowTypeError(env, "Failed to open CoreAudio output");
            return env.Null();
        }
    }

#elif defined(EXCLUSIVE_LINUX)

    bool exclusive = (mode == "exclusive");

    ok = InitAlsa(s, deviceId, exclusive, bufferMs, bitPerfect);
    if (!ok)
    {
        if (strictBitPerfect && exclusive)
        {
            delete s;
            ThrowTypeError(env, "Exclusive format not supported in strict bitPerfect mode");
            return env.Null();
        }

        // Try without exclusive mode as fallback
        ok = InitAlsa(s, deviceId, false, bufferMs, false);
        if (!ok)
        {
            delete s;
            ThrowTypeError(env, "Failed to open ALSA output");
            return env.Null();
        }
    }

#else
    (void)deviceId;
    (void)mode;
    (void)bufferMs;
    delete s;
    ThrowTypeError(env, "exclusive_audio is not supported on this platform");
    return env.Null();
#endif

    uint32_t handle;
    {
        std::lock_guard<std::mutex> lock(g_streamsMutex);
        handle = g_nextId++;
        g_streams[handle] = s;
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("handle", Napi::Number::New(env, handle));
    result.Set("sampleRate", Napi::Number::New(env, s->sampleRate));
    result.Set("channels", Napi::Number::New(env, s->channels));
    result.Set("bitDepth", Napi::Number::New(env, s->bitDepth));
    result.Set("sampleFormat", Napi::String::New(env, SampleFormatName(s)));
    result.Set("backend", Napi::String::New(env, s->openedBackend));
    result.Set("fallback", Napi::Boolean::New(env, s->fallbackUsed));
    result.Set("fallbackReason", Napi::String::New(env, s->fallbackReason));
    result.Set("ringDurationMs", Napi::Number::New(env, s->ringDurationMs));
#if defined(EXCLUSIVE_WIN32)
    const double openedBufferFrames = s->asioMode ? static_cast<double>(s->asioBufferSize) : static_cast<double>(s->bufferFrames);
    result.Set("bufferFrames", Napi::Number::New(env, openedBufferFrames));
    result.Set("bufferMs", Napi::Number::New(env, s->sampleRate > 0 ? (openedBufferFrames * 1000.0 / static_cast<double>(s->sampleRate)) : 0.0));
#endif
    return result;
}

static Napi::Value Write(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBuffer())
    {
        ThrowTypeError(env, "write(handle, buffer[, blocking]) requires a handle and Buffer");
        return env.Null();
    }

    uint32_t handle = info[0].As<Napi::Number>().Uint32Value();
    Napi::Buffer<uint8_t> buf = info[1].As<Napi::Buffer<uint8_t>>();

    bool blocking = false;
    if (info.Length() >= 3 && info[2].IsBoolean())
    {
        blocking = info[2].As<Napi::Boolean>().Value();
    }

    const uint8_t *data = buf.Data();
    size_t len = buf.Length();

    OutputStreamState *s = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_streamsMutex);
        auto it = g_streams.find(handle);
        if (it == g_streams.end())
        {
            ThrowTypeError(env, "write() called with invalid handle");
            return env.Null();
        }
        s = it->second;
        if (s->closing.load())
            return Napi::Number::New(env, -1);
        s->inFlightOps.fetch_add(1, std::memory_order_acq_rel);
    }

    int written = -1;

#if defined(EXCLUSIVE_WIN32)
    written = s->asioMode ? WriteAsio(s, data, len, blocking) : WriteWasapi(s, data, len, blocking);
#elif defined(EXCLUSIVE_MACOS)
    written = WriteCoreAudio(s, data, len, blocking);
#elif defined(EXCLUSIVE_LINUX)
    written = WriteAlsa(s, data, len, blocking);
#else
    (void)s;
    (void)data;
    (void)blocking;
    written = -1;
#endif

    s->inFlightOps.fetch_sub(1, std::memory_order_acq_rel);
    return Napi::Number::New(env, written);
}

// Async write worker: performs a (possibly blocking) write off the main thread
class WriteAsyncWorker : public Napi::AsyncWorker
{
public:
    WriteAsyncWorker(const Napi::Function &callback,
                     uint32_t handle,
                     std::vector<uint8_t> &&data,
                     bool blocking)
        : Napi::AsyncWorker(callback.Env()),
          handle(handle),
          data(std::move(data)),
          blocking(blocking),
          written(0),
          cancelled(false),
          cbEnv(callback.Env()),
          cbRef(nullptr)
    {
        napi_status st = napi_create_reference(cbEnv, callback, 1, &cbRef);
        if (st != napi_ok)
        {
            cbRef = nullptr;
            cancelled.store(true);
        }
    }

    ~WriteAsyncWorker() override
    {
        if (cbEnv && cbRef)
        {
            napi_delete_reference(cbEnv, cbRef);
            cbRef = nullptr;
        }
    }

    void Execute() override
    {
        OutputStreamState *s = nullptr;

        {
            std::lock_guard<std::mutex> lock(g_streamsMutex);
            auto it = g_streams.find(handle);
            if (it == g_streams.end())
            {
                cancelled.store(true);
                return;
            }

            s = it->second;

            if (!s || s->closing.load())
            {
                cancelled.store(true);
                return;
            }

            // IMPORTANT: increment while lock is held
            s->inFlightOps.fetch_add(1, std::memory_order_acq_rel);
        }

        // Do the write outside the lock
#if defined(EXCLUSIVE_WIN32)
        written = s->asioMode ? WriteAsio(s, data.data(), data.size(), blocking) : WriteWasapi(s, data.data(), data.size(), blocking);
#elif defined(EXCLUSIVE_MACOS)
        written = WriteCoreAudio(s, data.data(), data.size(), blocking);
#elif defined(EXCLUSIVE_LINUX)
        written = WriteAlsa(s, data.data(), data.size(), blocking);
#else
        written = -1;
#endif

        // Decrement at end
        s->inFlightOps.fetch_sub(1, std::memory_order_acq_rel);
    }

    void OnOK() override
    {
        if (cancelled.load())
            return;
        if (!IsHandleActive())
            return;
        InvokeJsCallback(nullptr);
    }

    void OnError(const Napi::Error &e) override
    {
        if (cancelled.load())
            return;
        InvokeJsCallback(e.Message().c_str());
    }

private:
    bool IsHandleActive() const
    {
        std::lock_guard<std::mutex> lock(g_streamsMutex);
        auto it = g_streams.find(handle);
        return it != g_streams.end() && it->second && !it->second->closing.load();
    }

    void InvokeJsCallback(const char *err)
    {
        if (!cbEnv || !cbRef)
            return;

        napi_value cb = nullptr;
        if (napi_get_reference_value(cbEnv, cbRef, &cb) != napi_ok || cb == nullptr)
            return;

        napi_value recv = nullptr;
        if (napi_get_undefined(cbEnv, &recv) != napi_ok)
            return;

        napi_value argv[2] = {nullptr, nullptr};
        if (err && err[0])
        {
            if (napi_create_string_utf8(cbEnv, err, NAPI_AUTO_LENGTH, &argv[0]) != napi_ok)
                return;
            if (napi_get_undefined(cbEnv, &argv[1]) != napi_ok)
                return;
        }
        else
        {
            if (napi_get_null(cbEnv, &argv[0]) != napi_ok)
                return;
            if (napi_create_double(cbEnv, static_cast<double>(written), &argv[1]) != napi_ok)
                return;
        }

        napi_status callStatus = napi_call_function(cbEnv, recv, cb, 2, argv, nullptr);
        if (callStatus != napi_ok)
            return;

        bool pending = false;
        if (napi_is_exception_pending(cbEnv, &pending) == napi_ok && pending)
        {
            napi_value ignored;
            napi_get_and_clear_last_exception(cbEnv, &ignored);
        }
    }

    uint32_t handle;
    std::vector<uint8_t> data;
    bool blocking;
    int written;
    std::atomic<bool> cancelled;
    napi_env cbEnv;
    napi_ref cbRef;
};

static Napi::Value WriteAsync(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsBuffer() || !info[2].IsFunction())
    {
        ThrowTypeError(env, "writeAsync(handle, buffer, callback[, blocking]) requires handle, Buffer and callback");
        return env.Null();
    }

    uint32_t handle = info[0].As<Napi::Number>().Uint32Value();
    Napi::Buffer<uint8_t> buf = info[1].As<Napi::Buffer<uint8_t>>();
    Napi::Function cb = info[2].As<Napi::Function>();

    bool blocking = true;
    if (info.Length() >= 4 && info[3].IsBoolean())
        blocking = info[3].As<Napi::Boolean>().Value();

    std::vector<uint8_t> copy(buf.Length());
    std::memcpy(copy.data(), buf.Data(), buf.Length());

    WriteAsyncWorker *w = new WriteAsyncWorker(cb, handle, std::move(copy), blocking);
    w->Queue();
    return env.Undefined();
}

static Napi::Value Close(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber())
    {
        ThrowTypeError(env, "close(handle) requires a handle");
        return env.Null();
    }

    uint32_t handle = info[0].As<Napi::Number>().Uint32Value();

    OutputStreamState *s = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_streamsMutex);
        auto it = g_streams.find(handle);
        if (it != g_streams.end())
        {
            s = it->second;
            g_streams.erase(it);
        }
    }

    if (s)
    {
        // Mark closing
        s->closing.store(true);

        // Stop backend
#if defined(EXCLUSIVE_WIN32)
        if (s->asioMode)
            CloseAsio(s);
        else
            CloseWasapi(s);
#elif defined(EXCLUSIVE_MACOS)
        CloseCoreAudio(s);
#elif defined(EXCLUSIVE_LINUX)
        CloseAlsa(s);
#endif

        // WAIT for async workers
        while (s->inFlightOps.load(std::memory_order_acquire) > 0)
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }

        delete s;
    }

    return env.Undefined();
}


static Napi::Value OpenAsioControlPanel(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
#if defined(EXCLUSIVE_WIN32)
    std::string deviceId;
    HWND windowHandle = nullptr;

    if (info.Length() >= 1 && info[0].IsObject())
    {
        Napi::Object opts = info[0].As<Napi::Object>();
        if (opts.Has("deviceId") && opts.Get("deviceId").IsString())
            deviceId = opts.Get("deviceId").As<Napi::String>().Utf8Value();
        if (opts.Has("windowHandle") && opts.Get("windowHandle").IsBuffer())
        {
            auto buf = opts.Get("windowHandle").As<Napi::Buffer<uint8_t>>();
            uintptr_t raw = 0;
            const size_t copyLen = std::min(buf.Length(), sizeof(raw));
            if (copyLen > 0)
                std::memcpy(&raw, buf.Data(), copyLen);
            windowHandle = reinterpret_cast<HWND>(raw);
        }
    }

    SetLastErrStr("");
    AsioDriverInfoHost driver{};
    if (!ResolveAsioDriver(deviceId, driver))
    {
        ThrowTypeError(env, "No installed ASIO driver matched the selected output device");
        return env.Null();
    }

    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    const bool didCoInit = SUCCEEDED(hr);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE)
    {
        SetLastErrorHr("CoInitializeEx failed", hr);
        ThrowTypeError(env, "Failed to open ASIO control panel");
        return env.Null();
    }

    IASIOHost *asio = nullptr;
    constexpr DWORD asioClsContext = CLSCTX_INPROC_SERVER | CLSCTX_LOCAL_SERVER;
    hr = CoCreateInstance(driver.clsid, nullptr, asioClsContext, driver.clsid, reinterpret_cast<void **>(&asio));
    if (FAILED(hr) || !asio)
    {
        IUnknown *unknown = nullptr;
        HRESULT fallbackHr = CoCreateInstance(driver.clsid, nullptr, asioClsContext, IID_IUnknown, reinterpret_cast<void **>(&unknown));
        if (SUCCEEDED(fallbackHr) && unknown)
        {
            void *queried = nullptr;
            fallbackHr = unknown->QueryInterface(driver.clsid, &queried);
            unknown->Release();
            if (SUCCEEDED(fallbackHr) && queried)
                asio = reinterpret_cast<IASIOHost *>(queried);
        }

        if (!asio)
        {
            SetLastErrorHr("CoCreateInstance(ASIO driver) failed", FAILED(hr) ? hr : fallbackHr);
            if (didCoInit)
                CoUninitialize();
            ThrowTypeError(env, "Failed to open ASIO control panel");
            return env.Null();
        }
    }

    HWND hwnd = windowHandle;
    if (!hwnd)
        hwnd = GetForegroundWindow();
    if (!hwnd)
        hwnd = GetDesktopWindow();

    if (!asio->init(hwnd))
    {
        char errMsg[128]{};
        asio->getErrorMessage(errMsg);
        std::string msg = "ASIO driver init failed";
        if (errMsg[0])
            msg.append(": ").append(errMsg);
        SetLastErrStr(msg);
        asio->Release();
        if (didCoInit)
            CoUninitialize();
        ThrowTypeError(env, "Failed to open ASIO control panel");
        return env.Null();
    }

    ASIOErrorHost panelErr = asio->controlPanel();
    asio->Release();
    if (didCoInit)
        CoUninitialize();

    if (!AsioOk(panelErr))
    {
        SetLastErrStr("ASIO controlPanel failed");
        ThrowTypeError(env, "Failed to open ASIO control panel");
        return env.Null();
    }

    return Napi::Boolean::New(env, true);
#else
    ThrowTypeError(env, "ASIO control panel is only available on Windows");
    return env.Null();
#endif
}
static Napi::Value GetDevices(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    (void)info;

#if defined(EXCLUSIVE_WIN32)
    return GetWasapiDevices(env);
#elif defined(EXCLUSIVE_MACOS)
    return GetCoreAudioDevices(env);
#elif defined(EXCLUSIVE_LINUX)
    return GetAlsaDevices(env);
#else
    return Napi::Array::New(env);
#endif
}

static Napi::Value IsSupported(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    (void)info;

#if defined(EXCLUSIVE_WIN32) || defined(EXCLUSIVE_MACOS) || defined(EXCLUSIVE_LINUX)
    return Napi::Boolean::New(env, true);
#else
    return Napi::Boolean::New(env, false);
#endif
}

static Napi::Value GetStats(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber())
    {
        ThrowTypeError(env, "getStats(handle) requires a handle");
        return env.Null();
    }

    uint32_t handle = info[0].As<Napi::Number>().Uint32Value();

    OutputStreamState *s = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_streamsMutex);
        auto it = g_streams.find(handle);
        if (it != g_streams.end() && !it->second->closing.load())
        {
            s = it->second;
            s->inFlightOps.fetch_add(1, std::memory_order_acq_rel);
        }
    }

    if (!s)
        return env.Null();

    size_t buffered = s->ring.availableToRead();
    size_t freeBytes = s->ring.availableToWrite();
    size_t ringSizeBytes = s->ring.size();

    // Compute latency: ring buffer latency + approximate hardware latency
    double ringFrames = 0.0;
    double ringLatencyMs = 0.0;
    double hardwareLatencyMs = 0.0;
    if (s->bytesPerFrame > 0)
    {
        ringFrames = static_cast<double>(buffered) / static_cast<double>(s->bytesPerFrame);
        ringLatencyMs = (ringFrames * 1000.0) / static_cast<double>(s->sampleRate);
        uint32_t hwPadding = s->lastHardwarePaddingFrames.load();
        hardwareLatencyMs = (static_cast<double>(hwPadding) * 1000.0) / static_cast<double>(s->sampleRate);
    }

    Napi::Object res = Napi::Object::New(env);
    res.Set("buffered", Napi::Number::New(env, buffered));
    res.Set("free", Napi::Number::New(env, freeBytes));
    res.Set("ringSize", Napi::Number::New(env, ringSizeBytes));
    res.Set("sampleRate", Napi::Number::New(env, s->sampleRate));
    res.Set("channels", Napi::Number::New(env, s->channels));
    res.Set("bitDepth", Napi::Number::New(env, s->bitDepth));
    res.Set("sampleFormat", Napi::String::New(env, SampleFormatName(s)));
    res.Set("backend", Napi::String::New(env, s->openedBackend));
    res.Set("fallback", Napi::Boolean::New(env, s->fallbackUsed));
    res.Set("fallbackReason", Napi::String::New(env, s->fallbackReason));
    res.Set("bytesPerFrame", Napi::Number::New(env, s->bytesPerFrame));
    res.Set("ringDurationMs", Napi::Number::New(env, s->ringDurationMs));
#if defined(EXCLUSIVE_WIN32)
    const double statsBufferFrames = s->asioMode ? static_cast<double>(s->asioBufferSize) : static_cast<double>(s->bufferFrames);
    res.Set("bufferFrames", Napi::Number::New(env, statsBufferFrames));
    res.Set("bufferMs", Napi::Number::New(env, s->sampleRate > 0 ? (statsBufferFrames * 1000.0 / static_cast<double>(s->sampleRate)) : 0.0));
    if (s->asioMode)
    {
        res.Set("asioCallbacks", Napi::Number::New(env, s->asioCallbacks.load(std::memory_order_relaxed)));
        res.Set("asioMessages", Napi::Number::New(env, s->asioMessages.load(std::memory_order_relaxed)));
        res.Set("asioLastMessageSelector", Napi::Number::New(env, s->asioLastMessageSelector.load(std::memory_order_relaxed)));
        res.Set("asioResetRequests", Napi::Number::New(env, s->asioResetRequests.load(std::memory_order_relaxed)));
        res.Set("asioOverloads", Napi::Number::New(env, s->asioOverloads.load(std::memory_order_relaxed)));
        res.Set("asioPostOutputReady", Napi::Boolean::New(env, s->asioPostOutputReady));
        res.Set("asioDriverName", Napi::String::New(env, s->asioDriverName));
    }
#endif
    res.Set("ringLatencyMs", Napi::Number::New(env, ringLatencyMs));
    res.Set("hardwareLatencyMs", Napi::Number::New(env, hardwareLatencyMs));
    res.Set("totalSystemLatencyMs", Napi::Number::New(env, ringLatencyMs + hardwareLatencyMs));
    res.Set("running", Napi::Boolean::New(env, s->running.load()));
    res.Set("paused", Napi::Boolean::New(env, s->paused.load()));

#if defined(EXCLUSIVE_LINUX)
    if (s->bufferSize > 0 && s->periodSize > 0)
    {
        res.Set("bufferSize", Napi::Number::New(env, s->bufferSize));
        res.Set("periodSize", Napi::Number::New(env, s->periodSize));
    }
#endif

    s->inFlightOps.fetch_sub(1, std::memory_order_acq_rel);
    return res;
}

static Napi::Value Pause(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber())
    {
        ThrowTypeError(env, "pause(handle) requires a handle");
        return env.Null();
    }

    uint32_t handle = info[0].As<Napi::Number>().Uint32Value();

    OutputStreamState *s = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_streamsMutex);
        auto it = g_streams.find(handle);
        if (it != g_streams.end() && !it->second->closing.load())
        {
            s = it->second;
            s->inFlightOps.fetch_add(1, std::memory_order_acq_rel);
        }
    }

    if (s)
    {
        s->paused.store(true);
        s->inFlightOps.fetch_sub(1, std::memory_order_acq_rel);
    }

    return env.Null();
}

static Napi::Value Resume(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber())
    {
        ThrowTypeError(env, "resume(handle) requires a handle");
        return env.Null();
    }

    uint32_t handle = info[0].As<Napi::Number>().Uint32Value();

    OutputStreamState *s = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_streamsMutex);
        auto it = g_streams.find(handle);
        if (it != g_streams.end() && !it->second->closing.load())
        {
            s = it->second;
            s->inFlightOps.fetch_add(1, std::memory_order_acq_rel);
        }
    }

    if (s)
    {
        s->paused.store(false);
        s->inFlightOps.fetch_sub(1, std::memory_order_acq_rel);
    }

    return env.Null();
}

static Napi::Value Drain(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber())
    {
        ThrowTypeError(env, "drain(handle) requires a handle");
        return env.Null();
    }

    uint32_t handle = info[0].As<Napi::Number>().Uint32Value();
    OutputStreamState *s = nullptr;

    {
        std::lock_guard<std::mutex> lock(g_streamsMutex);
        auto it = g_streams.find(handle);
        if (it != g_streams.end() && !it->second->closing.load())
        {
            s = it->second;
            s->inFlightOps.fetch_add(1, std::memory_order_acq_rel);
        }
    }

    if (!s)
        return env.Null();

    {
        std::unique_lock<std::mutex> lock(s->ringMutex);
        // Also exit if paused (ring won't drain while paused) or stream stops
        s->ringCv.wait(lock, [s]() {
            return s->ring.availableToRead() == 0
                || !s->running.load()
                || s->paused.load();
        });
    }

    s->inFlightOps.fetch_sub(1, std::memory_order_acq_rel);
    return env.Undefined();
}

static Napi::Value GetLastErrorJs(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    (void)info;
    return Napi::String::New(env, GetLastErrStr());
}

static Napi::Object InitAll(Napi::Env env, Napi::Object exports)
{
    exports.Set("openOutput", Napi::Function::New(env, OpenOutput));
    exports.Set("write", Napi::Function::New(env, Write));
    exports.Set("writeAsync", Napi::Function::New(env, WriteAsync));
    exports.Set("close", Napi::Function::New(env, Close));
    exports.Set("getDevices", Napi::Function::New(env, GetDevices));
    exports.Set("isSupported", Napi::Function::New(env, IsSupported));
    exports.Set("getStats", Napi::Function::New(env, GetStats));
    exports.Set("openAsioControlPanel", Napi::Function::New(env, OpenAsioControlPanel));
    exports.Set("pause", Napi::Function::New(env, Pause));
    exports.Set("resume", Napi::Function::New(env, Resume));
    exports.Set("drain", Napi::Function::New(env, Drain));
    exports.Set("getLastError", Napi::Function::New(env, GetLastErrorJs));
    return exports;
}

NODE_API_MODULE(exclusive_audio, InitAll)
