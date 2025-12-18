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
#define DBG(msg)              \
    do                        \
    {                         \
        printf("[native] %s\n", msg); \
        fflush(stdout);       \
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
#define DBG(msg)                          \
    do                                    \
    {                                     \
        fprintf(stderr, "[native] %s\n", msg); \
        fflush(stderr);                    \
    } while (0)
#endif

struct OutputStreamState;

static std::map<uint32_t, OutputStreamState *> g_streams;
static std::mutex g_streamsMutex;
static uint32_t g_nextId = 1;

static std::string g_lastError;

static void SetLastError(const std::string &msg)
{
    g_lastError = msg;
}

static void SetLastErrorHr(const char *msg, long hr)
{
    char buf[256];
    std::snprintf(buf, sizeof(buf), "%s (HRESULT=0x%08lx)", msg, hr);
    g_lastError = buf;
}

#if defined(EXCLUSIVE_LINUX)
static void SetLastErrorAlsa(const char *msg, int err)
{
    char buf[256];
    std::snprintf(buf, sizeof(buf), "%s (ALSA error: %s)", msg, snd_strerror(err));
    g_lastError = buf;
}
#else
static void SetLastErrorAlsa(const char *msg, int err)
{
    char buf[256];
    std::snprintf(buf, sizeof(buf), "%s (error: %d)", msg, err);
    g_lastError = buf;
}
#endif

static inline void ThrowTypeError(const Napi::Env &env, const std::string &msg)
{
    std::string full = msg;
    if (!g_lastError.empty())
    {
        full.append(" - ").append(g_lastError);
    }
    Napi::TypeError::New(env, full).ThrowAsJavaScriptException();
}

// Single-Producer Single-Consumer lock-free ring buffer.
// Writer: JS / Node thread (producer). Reader: audio render thread (consumer).
struct RingBuffer
{
    std::vector<uint8_t> data;
    size_t capacity{0};
    std::atomic<size_t> readPos{0};   // head (consumer)
    std::atomic<size_t> writePos{0};  // tail (producer)

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
    double       ringDurationMs{0.0};

    std::atomic<bool> open{false};
    std::atomic<bool> running{false};
    std::atomic<bool> paused{false};

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
    bool coInitialized{false};
    std::thread renderThread;
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

static void BuildPcmFormat(
    unsigned int sampleRate,
    unsigned int channels,
    unsigned int bitDepth,
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
    fmt.SubFormat = KSDATAFORMAT_SUBTYPE_PCM;
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

static void WasapiRenderThread(OutputStreamState *s)
{
    DBG("WasapiRenderThread: starting");
    if (!s || !s->audioClient || !s->renderClient || !s->hEvent)
    {
        DBG("WasapiRenderThread: invalid state");
        if (s) s->open.store(false);
        return;
    }

    const UINT32 frameBytes = s->bytesPerFrame;
    s->running.store(true);

    // Register with MMCSS for high-priority audio processing
    HANDLE mmcssHandle = nullptr;
    DWORD mmcssTaskIndex = 0;
    mmcssHandle = AvSetMmThreadCharacteristicsA("Pro Audio", &mmcssTaskIndex);
    
    HRESULT hr = s->audioClient->Start();
    if (FAILED(hr))
    {
        SetLastErrorHr("IAudioClient::Start failed", hr);
        s->running.store(false);
        s->open.store(false); 
        if (mmcssHandle) AvRevertMmThreadCharacteristics(mmcssHandle);
        return;
    }

    std::vector<uint8_t> temp;

    while (s->running.load() && s->open.load())
    {
        // Wait for WASAPI to signal that it needs more data
        DWORD waitRes = WaitForSingleObject(s->hEvent, 1000); 
        
        if (!s->running.load()) break;

        if (waitRes != WAIT_OBJECT_0) {
            if (waitRes == WAIT_TIMEOUT) continue; // Watchdog timeout, retry loop
            break; // Fatal error
        }

        UINT32 padding = 0;
        hr = s->audioClient->GetCurrentPadding(&padding);
        if (FAILED(hr)) {
            DBG("WasapiRenderThread: Device lost during padding check");
            break; 
        }

        s->lastHardwarePaddingFrames.store(padding);

        UINT32 framesToWrite = (s->bufferFrames > padding) ? (s->bufferFrames - padding) : 0;
        if (framesToWrite == 0) continue;

        BYTE *data = nullptr;
        hr = s->renderClient->GetBuffer(framesToWrite, &data);
        if (FAILED(hr) || !data) {
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
        if (FAILED(hr)) {
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
    if (mmcssHandle) AvRevertMmThreadCharacteristics(mmcssHandle);
}
static bool InitWasapi(OutputStreamState *s,
                       const std::string &deviceId,
                       bool exclusive,
                       double bufferMs,
                       bool bitPerfect)
{
    if (!s)
        return false;

    SetLastError("");
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
            SetLastError("Invalid deviceId encoding");
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
                std::sprintf(tmp, "InitWasapi ERROR: %s (hr=0x%08lx)", "CoCreateInstance", hr);
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
            std::sprintf(tmp, "InitWasapi ERROR: %s (hr=0x%08lx)", "Get IMMDevice", hr);
            DBG(tmp);
        }
        return false;
    }

    s->device = device;

    IAudioClient *client = nullptr;
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                          (void **)&client);
    if (FAILED(hr) || !client)
    {
        SetLastErrorHr("IMMDevice::Activate(IAudioClient) failed", hr);
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
                s->bytesPerFrame = (s->bitDepth / 8) * s->channels;
                formatToUse = &reqExt.Format;
                found = true;
                break;
            }
        }

        if (!found)
        {
            client->Release();
            SetLastErrorHr("Exclusive format not supported", hr);
            {
                char tmp[256];
                std::sprintf(tmp, "InitWasapi ERROR: %s (hr=0x%08lx)", "IsFormatSupported", hr);
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
            SetLastErrorHr("GetMixFormat failed", hr);
            {
                char tmp[256];
                std::sprintf(tmp, "InitWasapi ERROR: %s (hr=0x%08lx)", "GetMixFormat", hr);
                DBG(tmp);
            }
            return false;
        }

        s->sampleRate = mixFormat->nSamplesPerSec;
        s->channels = mixFormat->nChannels;
        s->bitDepth = mixFormat->wBitsPerSample;
        formatToUse = mixFormat;
    }

    s->bytesPerFrame = (s->bitDepth / 8) * s->channels;

    REFERENCE_TIME hnsBuffer = 1000000; // 100ms
    HRESULT initHr;
    if (exclusive)
    {
        initHr = client->Initialize(
            AUDCLNT_SHAREMODE_EXCLUSIVE,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            hnsBuffer,
            hnsBuffer,
            formatToUse,
            NULL);
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
        client->Release();
        {
            char tmp[256];
            std::sprintf(tmp, "InitWasapi ERROR: %s (hr=0x%08lx)", "Initialize", initHr);
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
        SetLastErrorHr("GetBufferSize failed", hr);
        return false;
    }

    HANDLE hEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    if (!hEvent)
    {
        client->Release();
        SetLastError("CreateEvent failed");
        return false;
    }

    hr = client->SetEventHandle(hEvent);
    if (FAILED(hr))
    {
        CloseHandle(hEvent);
        client->Release();
        SetLastErrorHr("SetEventHandle failed", hr);
        return false;
    }

    IAudioRenderClient *render = nullptr;
    hr = client->GetService(__uuidof(IAudioRenderClient), (void **)&render);
    if (FAILED(hr) || !render)
    {
        CloseHandle(hEvent);
        client->Release();
        SetLastErrorHr("GetService(IAudioRenderClient) failed", hr);
        return false;
    }

    s->audioClient = client;
    s->renderClient = render;
    s->hEvent = hEvent;
    s->bufferFrames = bufferFrames;

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
    if (!s->running.load()) return -1; 

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

        Napi::Array rates = Napi::Array::New(env);
        rates.Set(uint32_t(0), Napi::Number::New(env, 44100));
        rates.Set(uint32_t(1), Napi::Number::New(env, 48000));
        rates.Set(uint32_t(2), Napi::Number::New(env, 96000));
        obj.Set("sampleRates", rates);

        arr.Set(outIdx++, obj);

        CoTaskMemFree(id);
        dev->Release();
    }

    collection->Release();
    enumerator->Release();
    if (didCoInit)
        CoUninitialize();
    return arr;
}

#endif // EXCLUSIVE_WIN32

#if defined(EXCLUSIVE_MACOS)

// Helper function to convert CFString to std::string
static std::string CFStringToStdString(CFStringRef cfStr) {
    if (!cfStr) return "";
    
    const char *cstr = CFStringGetCStringPtr(cfStr, kCFStringEncodingUTF8);
    if (cstr) return std::string(cstr);
    
    CFIndex length = CFStringGetLength(cfStr);
    CFIndex maxSize = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
    std::vector<char> buffer(maxSize);
    
    if (CFStringGetCString(cfStr, buffer.data(), maxSize, kCFStringEncodingUTF8)) {
        return std::string(buffer.data());
    }
    return "";
}

// Get all audio devices on macOS
static Napi::Array GetCoreAudioDevices(const Napi::Env &env) {
    Napi::Array arr = Napi::Array::New(env);
    uint32_t outIdx = 0;
    
    // Get all audio devices
    AudioObjectPropertyAddress propAddress = {
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    
    UInt32 dataSize = 0;
    OSStatus err = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, 
                                                  &propAddress, 
                                                  0, 
                                                  NULL, 
                                                  &dataSize);
    if (err != noErr) {
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
    if (err != noErr) {
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
    for (UInt32 i = 0; i < deviceCount; i++) {
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
        if (err != noErr || dataSize == 0) {
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
        if (err != noErr || !deviceUID) {
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
        
        if (deviceUID) CFRelease(deviceUID);
        if (deviceName) CFRelease(deviceName);
        
        if (uid.empty()) {
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
        
        if (err == noErr && dataSize > 0) {
            sampleRates.resize(dataSize / sizeof(AudioValueRange));
            err = AudioObjectGetPropertyData(deviceID,
                                             &propAddress,
                                             0,
                                             NULL,
                                             &dataSize,
                                             sampleRates.data());
            
            if (err == noErr) {
                // Add common sample rates within the supported range
                double commonRates[] = {44100.0, 48000.0, 88200.0, 96000.0, 176400.0, 192000.0};
                for (size_t j = 0; j < sizeof(commonRates)/sizeof(commonRates[0]); j++) {
                    bool supported = false;
                    for (const auto& range : sampleRates) {
                        if (commonRates[j] >= range.mMinimum && commonRates[j] <= range.mMaximum) {
                            supported = true;
                            break;
                        }
                    }
                    if (supported) {
                        ratesArray.Set(rateIdx++, Napi::Number::New(env, commonRates[j]));
                    }
                }
            }
        }
        
        // If no specific rates found, add defaults
        if (rateIdx == 0) {
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
                         bool isFloat) {
    AudioStreamBasicDescription asbd = {0};
    asbd.mSampleRate = sampleRate;
    asbd.mFormatID = kAudioFormatLinearPCM;
    
    if (isFloat) {
        asbd.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    } else {
        asbd.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
    }
    
    if (bitDepth > 8) {
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
                                        AudioBufferList *ioData) {
    (void)ioActionFlags;
    (void)inTimeStamp;
    (void)inBusNumber;
    
    OutputStreamState *s = static_cast<OutputStreamState *>(inRefCon);
    if (!s || !s->running.load()) {
        // Fill with silence
        for (UInt32 i = 0; i < ioData->mNumberBuffers; ++i) {
            std::memset(ioData->mBuffers[i].mData, 0, ioData->mBuffers[i].mDataByteSize);
        }
        return noErr;
    }
    
    const size_t requestedBytes = static_cast<size_t>(inNumberFrames) * s->bytesPerFrame;
    // Track recent hardware callback size for approximate latency reporting
    s->lastHardwarePaddingFrames.store(inNumberFrames);
    
        if (s->paused.load()) {
        // Fill with silence when paused
        for (UInt32 i = 0; i < ioData->mNumberBuffers; ++i) {
            std::memset(ioData->mBuffers[i].mData, 0, ioData->mBuffers[i].mDataByteSize);
        }
        s->ringCv.notify_all();
        return noErr;
    }
    
    // For interleaved audio (most common on macOS)
        if (ioData->mNumberBuffers == 1) {
        uint8_t *outputBuffer = static_cast<uint8_t *>(ioData->mBuffers[0].mData);
        size_t bytesFromRing = 0;
        // Lock-free SPSC read by audio thread
        bytesFromRing = s->ring.read(outputBuffer, requestedBytes);
        
        if (bytesFromRing < requestedBytes) {
            std::memset(outputBuffer + bytesFromRing, 0, requestedBytes - bytesFromRing);
        }
        
        ioData->mBuffers[0].mDataByteSize = static_cast<UInt32>(requestedBytes);
    } 
    // For non-interleaved audio (less common)
    else {
        std::vector<uint8_t> interleaved(requestedBytes);
        size_t bytesFromRing = 0;

        // Lock-free SPSC read
        bytesFromRing = s->ring.read(interleaved.data(), requestedBytes);
        
        if (bytesFromRing < requestedBytes) {
            std::memset(interleaved.data() + bytesFromRing, 0, requestedBytes - bytesFromRing);
        }
        
        // Deinterleave if needed
        UInt32 bytesPerChannel = requestedBytes / ioData->mNumberBuffers;
        for (UInt32 i = 0; i < ioData->mNumberBuffers; ++i) {
            uint8_t *channelBuffer = static_cast<uint8_t *>(ioData->mBuffers[i].mData);
            
            // Extract channel i from interleaved data
            for (UInt32 frame = 0; frame < inNumberFrames; ++frame) {
                size_t srcOffset = frame * s->bytesPerFrame + i * (s->bitDepth / 8);
                size_t dstOffset = frame * (s->bitDepth / 8);
                
                if (srcOffset + (s->bitDepth / 8) <= interleaved.size()) {
                    std::memcpy(channelBuffer + dstOffset, 
                               interleaved.data() + srcOffset, 
                               s->bitDepth / 8);
                } else {
                    std::memset(channelBuffer + dstOffset, 0, s->bitDepth / 8);
                }
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
                         bool bitPerfect) {
    if (!s) return false;
    
    SetLastError("");
    
    AudioComponentDescription desc = {0};
    desc.componentType = kAudioUnitType_Output;
    desc.componentSubType = kAudioUnitSubType_HALOutput; // Use HAL for device selection
    desc.componentManufacturer = kAudioUnitManufacturer_Apple;
    desc.componentFlags = 0;
    desc.componentFlagsMask = 0;
    
    AudioComponent comp = AudioComponentFindNext(NULL, &desc);
    if (!comp) {
        SetLastError("AudioComponentFindNext failed");
        return false;
    }
    
    AudioComponentInstance audioUnit = NULL;
    OSStatus err = AudioComponentInstanceNew(comp, &audioUnit);
    if (err != noErr || !audioUnit) {
        SetLastError("AudioComponentInstanceNew failed");
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
    if (err != noErr) {
        AudioComponentInstanceDispose(audioUnit);
        SetLastError("Failed to enable output");
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
    if (err != noErr) {
        AudioComponentInstanceDispose(audioUnit);
        SetLastError("Failed to disable input");
        return false;
    }
    
    // Select specific device if requested
    if (!deviceId.empty() && deviceId != "default") {
        AudioDeviceID targetDevice = kAudioDeviceUnknown;
        
        // Find device by UID
        AudioObjectPropertyAddress propAddress = {
            kAudioHardwarePropertyDevices,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        
        UInt32 dataSize = 0;
        err = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject,
                                            &propAddress,
                                            0,
                                            NULL,
                                            &dataSize);
        if (err == noErr) {
            UInt32 deviceCount = dataSize / sizeof(AudioDeviceID);
            std::vector<AudioDeviceID> devices(deviceCount);
            
            err = AudioObjectGetPropertyData(kAudioObjectSystemObject,
                                            &propAddress,
                                            0,
                                            NULL,
                                            &dataSize,
                                            devices.data());
            
            if (err == noErr) {
                for (UInt32 i = 0; i < deviceCount; i++) {
                    propAddress.mSelector = kAudioDevicePropertyDeviceUID;
                    CFStringRef deviceUID = NULL;
                    dataSize = sizeof(deviceUID);
                    
                    err = AudioObjectGetPropertyData(devices[i],
                                                    &propAddress,
                                                    0,
                                                    NULL,
                                                    &dataSize,
                                                    &deviceUID);
                    
                    if (err == noErr && deviceUID) {
                        std::string uid = CFStringToStdString(deviceUID);
                        CFRelease(deviceUID);
                        
                        if (uid == deviceId) {
                            targetDevice = devices[i];
                            break;
                        }
                    }
                }
            }
        }
        
        if (targetDevice != kAudioDeviceUnknown) {
            err = AudioUnitSetProperty(audioUnit,
                                      kAudioOutputUnitProperty_CurrentDevice,
                                      kAudioUnitScope_Global,
                                      0,
                                      &targetDevice,
                                      sizeof(targetDevice));
            if (err != noErr) {
                AudioComponentInstanceDispose(audioUnit);
                SetLastError("Failed to set output device");
                return false;
            }
            // If exclusive requested, try to claim Hog Mode for the device
            if (exclusive) {
                AudioObjectPropertyAddress hogAddr = {
                    kAudioDevicePropertyHogMode,
                    kAudioObjectPropertyScopeGlobal,
                    kAudioObjectPropertyElementMain
                };
                pid_t pid = getpid();
                OSStatus hres = AudioObjectSetPropertyData(targetDevice,
                                                           &hogAddr,
                                                           0,
                                                           NULL,
                                                           sizeof(pid),
                                                           &pid);
                if (hres == noErr) {
                    DBG("InitCoreAudio: Hog Mode enabled for device");
                } else {
                    DBG("InitCoreAudio: Hog Mode request failed (continuing)");
                }
            }
        } else {
            // Device not found, fall back to default
        }
    }
    
    // Try to set the requested format
    bool formatSet = false;
    
    if (exclusive) {
        // Try different formats in order of preference
        std::vector<std::pair<unsigned int, bool>> candidates;
        
        if (s->bitDepth == 32) {
            if (bitPerfect) {
                candidates.push_back({32, true});  // Float32
                candidates.push_back({32, false}); // Int32
            } else {
                candidates.push_back({32, true});  // Float32
                candidates.push_back({32, false}); // Int32
                candidates.push_back({24, false}); // Int24
                candidates.push_back({16, false}); // Int16
            }
        } else if (s->bitDepth == 24) {
            if (bitPerfect) {
                candidates.push_back({24, false}); // Int24
            } else {
                candidates.push_back({24, false}); // Int24
                candidates.push_back({32, true});  // Float32
                candidates.push_back({32, false}); // Int32
                candidates.push_back({16, false}); // Int16
            }
        } else if (s->bitDepth == 16) {
            if (bitPerfect) {
                candidates.push_back({16, false}); // Int16
            } else {
                candidates.push_back({16, false}); // Int16
                candidates.push_back({32, true});  // Float32
                candidates.push_back({24, false}); // Int24
            }
        }
        
        for (const auto &candidate : candidates) {
            if (TrySetFormat(audioUnit, s->sampleRate, s->channels, 
                            candidate.first, candidate.second)) {
                s->bitDepth = candidate.first;
                formatSet = true;
                break;
            }
        }
    }
    
    // If exclusive mode failed or not requested, try to get the default format
    if (!formatSet) {
        // Get current format to see what's supported
        AudioStreamBasicDescription currentASBD = {0};
        UInt32 dataSize = sizeof(currentASBD);
        
        err = AudioUnitGetProperty(audioUnit,
                                  kAudioUnitProperty_StreamFormat,
                                  kAudioUnitScope_Input,
                                  0,
                                  &currentASBD,
                                  &dataSize);
        
        if (err == noErr) {
            s->sampleRate = currentASBD.mSampleRate;
            s->channels = currentASBD.mChannelsPerFrame;
            s->bitDepth = currentASBD.mBitsPerChannel;
            
            // Try to match requested sample rate if possible
            if (currentASBD.mSampleRate != s->sampleRate) {
                // Try to set the requested rate
                currentASBD.mSampleRate = s->sampleRate;
                err = AudioUnitSetProperty(audioUnit,
                                          kAudioUnitProperty_StreamFormat,
                                          kAudioUnitScope_Input,
                                          0,
                                          &currentASBD,
                                          sizeof(currentASBD));
                
                if (err != noErr) {
                    // Revert to actual sample rate
                    err = AudioUnitGetProperty(audioUnit,
                                              kAudioUnitProperty_StreamFormat,
                                              kAudioUnitScope_Input,
                                              0,
                                              &currentASBD,
                                              &dataSize);
                    if (err == noErr) {
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
    if (err != noErr) {
        AudioComponentInstanceDispose(audioUnit);
        SetLastError("Failed to set render callback");
        return false;
    }
    
    // Initialize audio unit
    err = AudioUnitInitialize(audioUnit);
    if (err != noErr) {
        AudioComponentInstanceDispose(audioUnit);
        SetLastError("AudioUnitInitialize failed");
        return false;
    }
    
    // Configure ring buffer
    if (bufferMs < 20.0) bufferMs = 20.0;
    if (bufferMs > 2000.0) bufferMs = 2000.0;
    
    double ringFramesD = (static_cast<double>(s->sampleRate) * bufferMs) / 1000.0;
    // Ensure at least 2 periods of audio
    double minFrames = static_cast<double>(s->sampleRate) / 50.0; // 20ms
    if (ringFramesD < minFrames) {
        ringFramesD = minFrames;
    }
    
    size_t ringFrames = static_cast<size_t>(ringFramesD);
    size_t ringBytes = ringFrames * s->bytesPerFrame;
    
    s->ring.init(ringBytes);
    s->ringDurationMs = static_cast<double>(ringFrames) * 1000.0 / static_cast<double>(s->sampleRate);
    
    // Start audio unit
    err = AudioOutputUnitStart(audioUnit);
    if (err != noErr) {
        AudioUnitUninitialize(audioUnit);
        AudioComponentInstanceDispose(audioUnit);
        SetLastError("AudioOutputUnitStart failed");
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
                         bool blocking) {
    if (!s || !s->open.load())
        return -1;
    if (!data || len == 0)
        return 0;
    
    uint32_t timeoutMs = blocking ? 2000u : 0u;
    size_t written = WriteToRingBlocking(s, data, len, timeoutMs);
    return static_cast<int>(written);
}

static void CloseCoreAudio(OutputStreamState *s) {
    if (!s)
        return;
    
    s->running.store(false);
    s->open.store(false);
    s->ringCv.notify_all();
    
    if (s->audioUnit) {
        AudioOutputUnitStop(s->audioUnit);
        AudioUnitUninitialize(s->audioUnit);
        AudioComponentInstanceDispose(s->audioUnit);
        s->audioUnit = nullptr;
    }
}

#endif // EXCLUSIVE_MACOS

#if defined(EXCLUSIVE_LINUX)

// Convert ALSA sample format to bit depth
static unsigned int AlsaFormatToBitDepth(snd_pcm_format_t format) {
    switch (format) {
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

// Convert bit depth to ALSA sample format
static snd_pcm_format_t BitDepthToAlsaFormat(unsigned int bitDepth, bool isFloat) {
    if (isFloat && bitDepth == 32) {
        return SND_PCM_FORMAT_FLOAT_LE;
    }
    
    switch (bitDepth) {
        case 16: return SND_PCM_FORMAT_S16_LE;
        case 24: return SND_PCM_FORMAT_S24_LE;
        case 32: return SND_PCM_FORMAT_S32_LE;
        default: return SND_PCM_FORMAT_S16_LE;
    }
}

// Try to set hardware parameters
static bool TrySetAlsaParams(snd_pcm_t *pcm,
                            OutputStreamState *s,
                            bool exclusive,
                            bool bitPerfect) {
    int err;
    snd_pcm_hw_params_t *hwParams = nullptr;
    
    // Allocate hardware parameters structure
    snd_pcm_hw_params_alloca(&hwParams);
    
    // Fill it in with default values
    err = snd_pcm_hw_params_any(pcm, hwParams);
    if (err < 0) {
        SetLastErrorAlsa("Cannot initialize hardware parameters", err);
        return false;
    }
    
    // Set access type (exclusive or shared)
    snd_pcm_access_t access = exclusive ? SND_PCM_ACCESS_RW_INTERLEAVED : SND_PCM_ACCESS_RW_INTERLEAVED;
    err = snd_pcm_hw_params_set_access(pcm, hwParams, access);
    if (err < 0) {
        if (exclusive) {
            // Try shared mode if exclusive fails
            access = SND_PCM_ACCESS_RW_INTERLEAVED;
            err = snd_pcm_hw_params_set_access(pcm, hwParams, access);
            if (err < 0) {
                SetLastErrorAlsa("Cannot set access type", err);
                return false;
            }
        } else {
            SetLastErrorAlsa("Cannot set access type", err);
            return false;
        }
    }
    
    // Try different formats
    bool formatSet = false;
    
    if (exclusive) {
        // Try different formats in order of preference
        std::vector<std::pair<unsigned int, bool>> candidates;
        
        if (s->bitDepth == 32) {
            if (bitPerfect) {
                candidates.push_back({32, true});  // Float32
                candidates.push_back({32, false}); // Int32
            } else {
                candidates.push_back({32, true});  // Float32
                candidates.push_back({32, false}); // Int32
                candidates.push_back({24, false}); // Int24
                candidates.push_back({16, false}); // Int16
            }
        } else if (s->bitDepth == 24) {
            if (bitPerfect) {
                candidates.push_back({24, false}); // Int24
            } else {
                candidates.push_back({24, false}); // Int24
                candidates.push_back({32, true});  // Float32
                candidates.push_back({32, false}); // Int32
                candidates.push_back({16, false}); // Int16
            }
        } else if (s->bitDepth == 16) {
            if (bitPerfect) {
                candidates.push_back({16, false}); // Int16
            } else {
                candidates.push_back({16, false}); // Int16
                candidates.push_back({32, true});  // Float32
                candidates.push_back({24, false}); // Int24
            }
        }
        
        for (const auto &candidate : candidates) {
            snd_pcm_format_t format = BitDepthToAlsaFormat(candidate.first, candidate.second);
            err = snd_pcm_hw_params_set_format(pcm, hwParams, format);
            if (err >= 0) {
                s->bitDepth = candidate.first;
                formatSet = true;
                break;
            }
        }
    }
    
    // If exclusive mode failed or not requested, try to get a supported format
    if (!formatSet) {
        // Get first supported format
        snd_pcm_format_t format;
        err = snd_pcm_hw_params_get_format(hwParams, &format);
        if (err >= 0) {
            s->bitDepth = AlsaFormatToBitDepth(format);
        } else {
            // Default to S16_LE
            err = snd_pcm_hw_params_set_format(pcm, hwParams, SND_PCM_FORMAT_S16_LE);
            if (err < 0) {
                SetLastErrorAlsa("Cannot set sample format", err);
                return false;
            }
            s->bitDepth = 16;
        }
    }
    
    // Set channels
    err = snd_pcm_hw_params_set_channels(pcm, hwParams, s->channels);
    if (err < 0) {
        // Try to get supported channels
        unsigned int minCh, maxCh;
        err = snd_pcm_hw_params_get_channels_min(hwParams, &minCh);
        if (err >= 0) {
            err = snd_pcm_hw_params_get_channels_max(hwParams, &maxCh);
            if (err >= 0 && s->channels >= minCh && s->channels <= maxCh) {
                // Try exact number
                err = snd_pcm_hw_params_set_channels(pcm, hwParams, s->channels);
            }
        }
        if (err < 0) {
            // Set to 2 channels (stereo) as fallback
            err = snd_pcm_hw_params_set_channels(pcm, hwParams, 2);
            if (err < 0) {
                SetLastErrorAlsa("Cannot set channels", err);
                return false;
            }
            s->channels = 2;
        }
    }
    
    // Set sample rate
    unsigned int actualRate = s->sampleRate;
    err = snd_pcm_hw_params_set_rate_near(pcm, hwParams, &actualRate, 0);
    if (err < 0) {
        SetLastErrorAlsa("Cannot set sample rate", err);
        return false;
    }
    s->sampleRate = actualRate;
    
    // Set buffer size based on latency
    snd_pcm_uframes_t bufferSize = (s->sampleRate * 100) / 1000; // 100ms default
    snd_pcm_uframes_t periodSize = bufferSize / 4; // 4 periods per buffer
    
    err = snd_pcm_hw_params_set_buffer_size_near(pcm, hwParams, &bufferSize);
    if (err < 0) {
        SetLastErrorAlsa("Cannot set buffer size", err);
        return false;
    }
    
    err = snd_pcm_hw_params_set_period_size_near(pcm, hwParams, &periodSize, 0);
    if (err < 0) {
        SetLastErrorAlsa("Cannot set period size", err);
        return false;
    }
    
    // Apply hardware parameters
    err = snd_pcm_hw_params(pcm, hwParams);
    if (err < 0) {
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
static void AlsaRenderThread(OutputStreamState *s) {
    if (!s || !s->pcmHandle) {
        return;
    }
    
    s->running.store(true);
    
    std::vector<uint8_t> tempBuffer(s->periodSize * s->bytesPerFrame);
    
    while (s->running.load()) {
        if (s->paused.load()) {
            // Fill buffer with silence when paused
            std::memset(tempBuffer.data(), 0, tempBuffer.size());
            
            int err = snd_pcm_writei(s->pcmHandle, tempBuffer.data(), s->periodSize);
            if (err == -EPIPE) {
                // Underrun occurred
                snd_pcm_prepare(s->pcmHandle);
            } else if (err < 0) {
                SetLastErrorAlsa("Write error", err);
                break;
            }
            
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }
        
        size_t bytesToRead = s->periodSize * s->bytesPerFrame;
        size_t bytesRead = 0;
        
        // Lock-free SPSC read on audio/render thread
        bytesRead = s->ring.read(tempBuffer.data(), bytesToRead);
        
        if (bytesRead < bytesToRead) {
            // Fill remaining with silence
            std::memset(tempBuffer.data() + bytesRead, 0, bytesToRead - bytesRead);
        }
        
        snd_pcm_sframes_t framesToWrite = bytesToRead / s->bytesPerFrame;
        snd_pcm_sframes_t framesWritten = snd_pcm_writei(s->pcmHandle, tempBuffer.data(), framesToWrite);
        
        if (framesWritten == -EPIPE) {
            // Underrun occurred
            int err = snd_pcm_prepare(s->pcmHandle);
            if (err < 0) {
                SetLastErrorAlsa("Cannot recover from underrun", err);
                break;
            }
        } else if (framesWritten < 0) {
            SetLastErrorAlsa("Write error", framesWritten);
            break;
        } else if (framesWritten < framesToWrite) {
            // Short write
            // We'll handle this by trying again next iteration
        }
        
        // Try to get ALSA delay (frames in hardware buffer) for stats
        snd_pcm_sframes_t delayFrames = 0;
        if (snd_pcm_delay(s->pcmHandle, &delayFrames) == 0 && delayFrames >= 0) {
            s->lastHardwarePaddingFrames.store(static_cast<uint32_t>(delayFrames));
        }
        s->ringCv.notify_all();
    }
    
    s->running.store(false);
}

// Initialize ALSA
static bool InitAlsa(OutputStreamState *s,
                     const std::string &deviceId,
                     bool exclusive,
                     double bufferMs,
                     bool bitPerfect) {
    if (!s) return false;
    
    SetLastError("");
    
    // Default ALSA device if none specified
    const char *device = deviceId.empty() ? "default" : deviceId.c_str();
    
    // Open PCM device
    snd_pcm_t *pcm = nullptr;
    int err = snd_pcm_open(&pcm, device, SND_PCM_STREAM_PLAYBACK, 0);
    if (err < 0) {
        SetLastErrorAlsa("Cannot open audio device", err);
        return false;
    }
    
    // Try to set hardware parameters
    if (!TrySetAlsaParams(pcm, s, exclusive, bitPerfect)) {
        snd_pcm_close(pcm);
        return false;
    }
    
    // Configure ring buffer
    if (bufferMs < 20.0) bufferMs = 20.0;
    if (bufferMs > 2000.0) bufferMs = 2000.0;
    
    double ringFramesD = (static_cast<double>(s->sampleRate) * bufferMs) / 1000.0;
    // Ensure at least 4 periods
    if (ringFramesD < static_cast<double>(s->periodSize) * 4) {
        ringFramesD = static_cast<double>(s->periodSize) * 4;
    }
    
    size_t ringFrames = static_cast<size_t>(ringFramesD);
    size_t ringBytes = ringFrames * s->bytesPerFrame;
    
    s->ring.init(ringBytes);
    s->ringDurationMs = static_cast<double>(ringFrames) * 1000.0 / static_cast<double>(s->sampleRate);
    
    // Start playback
    err = snd_pcm_prepare(pcm);
    if (err < 0) {
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
                     bool blocking) {
    if (!s || !s->open.load())
        return -1;
    if (!data || len == 0)
        return 0;
    
    uint32_t timeoutMs = blocking ? 2000u : 0u;
    size_t written = WriteToRingBlocking(s, data, len, timeoutMs);
    return static_cast<int>(written);
}

static void CloseAlsa(OutputStreamState *s) {
    if (!s)
        return;
    
    s->running.store(false);
    s->open.store(false);
    s->ringCv.notify_all();
    
    if (s->renderThread.joinable()) {
        s->renderThread.join();
    }
    
    if (s->pcmHandle) {
        snd_pcm_drain(s->pcmHandle); // Drain remaining samples
        snd_pcm_close(s->pcmHandle);
        s->pcmHandle = nullptr;
    }
}

static Napi::Array GetAlsaDevices(const Napi::Env &env) {
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
    if (err == 0 && hints) {
        for (void **hint = hints; *hint != nullptr; hint++) {
            char *name = snd_device_name_get_hint(*hint, "NAME");
            char *desc = snd_device_name_get_hint(*hint, "DESC");
            char *ioid = snd_device_name_get_hint(*hint, "IOID");
            
            if (name && (ioid == nullptr || strcmp(ioid, "Output") == 0)) {
                std::string deviceName = name;
                std::string deviceDesc = desc ? desc : name;
                
                // Skip duplicates and "null" device
                if (deviceName != "default" && deviceName.find("null") == std::string::npos) {
                    Napi::Object dev = Napi::Object::New(env);
                    dev.Set("id", Napi::String::New(env, deviceName));
                    dev.Set("name", Napi::String::New(env, deviceDesc));
                dev.Set("isDefault", Napi::Boolean::New(env, false));
                
                Napi::Array devRates = Napi::Array::New(env);
                devRates.Set((uint32_t)0, Napi::Number::New(env, 44100));
                devRates.Set((uint32_t)1, Napi::Number::New(env, 48000));
                devRates.Set((uint32_t)2, Napi::Number::New(env, 96000));
                dev.Set("sampleRates", devRates);                    arr.Set(outIdx++, dev);
                }
            }
            
            if (name) free(name);
            if (desc) free(desc);
            if (ioid) free(ioid);
        }
        snd_device_name_free_hint(hints);
    }
    
    return arr;
}

#endif // EXCLUSIVE_LINUX

//
// N-API exports
//

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

    auto *s = new OutputStreamState();
    s->sampleRate = sampleRate;
    s->channels = channels;
    s->bitDepth = bitDepth;
    s->bytesPerFrame = (bitDepth / 8) * channels;

    bool ok = false;

#if defined(EXCLUSIVE_WIN32)

    if (mode == "shared")
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
        }
    }
    else
    {
        delete s;
        ThrowTypeError(env, "Unknown mode; expected 'exclusive' or 'shared'");
        return env.Null();
    }

#elif defined(EXCLUSIVE_MACOS)

    bool exclusive = (mode == "exclusive");
    
    ok = InitCoreAudio(s, deviceId, exclusive, bufferMs, bitPerfect);
    if (!ok) {
        if (strictBitPerfect && exclusive) {
            delete s;
            ThrowTypeError(env, "Exclusive format not supported in strict bitPerfect mode");
            return env.Null();
        }
        
        // Try without exclusive mode as fallback
        ok = InitCoreAudio(s, deviceId, false, bufferMs, false);
        if (!ok) {
            delete s;
            ThrowTypeError(env, "Failed to open CoreAudio output");
            return env.Null();
        }
    }

#elif defined(EXCLUSIVE_LINUX)

    bool exclusive = (mode == "exclusive");
    
    ok = InitAlsa(s, deviceId, exclusive, bufferMs, bitPerfect);
    if (!ok) {
        if (strictBitPerfect && exclusive) {
            delete s;
            ThrowTypeError(env, "Exclusive format not supported in strict bitPerfect mode");
            return env.Null();
        }
        
        // Try without exclusive mode as fallback
        ok = InitAlsa(s, deviceId, false, bufferMs, false);
        if (!ok) {
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
    result.Set("ringDurationMs", Napi::Number::New(env, s->ringDurationMs));
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
    }

    int written = -1;

#if defined(EXCLUSIVE_WIN32)
    written = WriteWasapi(s, data, len, blocking);
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
        : Napi::AsyncWorker(callback), handle(handle), data(std::move(data)), blocking(blocking), written(0) {}

    void Execute() override
    {
        OutputStreamState *s = nullptr;
        {
            std::lock_guard<std::mutex> lock(g_streamsMutex);
            auto it = g_streams.find(handle);
            if (it != g_streams.end())
                s = it->second;
        }

        if (!s)
        {
            SetError("Invalid handle");
            return;
        }

#if defined(EXCLUSIVE_WIN32)
        written = WriteWasapi(s, data.data(), data.size(), blocking);
#elif defined(EXCLUSIVE_MACOS)
        written = WriteCoreAudio(s, data.data(), data.size(), blocking);
#elif defined(EXCLUSIVE_LINUX)
        written = WriteAlsa(s, data.data(), data.size(), blocking);
#else
        written = -1;
#endif
    }

    void OnOK() override
    {
        Napi::HandleScope scope(Env());
        Callback().Call({ Env().Null(), Napi::Number::New(Env(), static_cast<double>(written)) });
    }

    void OnError(const Napi::Error &e) override
    {
        Napi::HandleScope scope(Env());
        Callback().Call({ Napi::String::New(Env(), e.Message()) });
    }

private:
    uint32_t handle;
    std::vector<uint8_t> data;
    bool blocking;
    int written;
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
#if defined(EXCLUSIVE_WIN32)
        CloseWasapi(s);
#elif defined(EXCLUSIVE_MACOS)
        CloseCoreAudio(s);
#elif defined(EXCLUSIVE_LINUX)
        CloseAlsa(s);
#endif
        delete s;
    }

    return env.Undefined();
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
        if (it != g_streams.end())
        {
            s = it->second;
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
    res.Set("bytesPerFrame", Napi::Number::New(env, s->bytesPerFrame));
    res.Set("ringDurationMs", Napi::Number::New(env, s->ringDurationMs));
    res.Set("ringLatencyMs", Napi::Number::New(env, ringLatencyMs));
    res.Set("hardwareLatencyMs", Napi::Number::New(env, hardwareLatencyMs));
    res.Set("totalSystemLatencyMs", Napi::Number::New(env, ringLatencyMs + hardwareLatencyMs));
    res.Set("running", Napi::Boolean::New(env, s->running.load()));
    res.Set("paused", Napi::Boolean::New(env, s->paused.load()));

#if defined(EXCLUSIVE_LINUX)
    if (s->bufferSize > 0 && s->periodSize > 0) {
        res.Set("bufferSize", Napi::Number::New(env, s->bufferSize));
        res.Set("periodSize", Napi::Number::New(env, s->periodSize));
    }
#endif

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
        if (it != g_streams.end())
        {
            s = it->second;
        }
    }

    if (s)
    {
        s->paused.store(true);
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
        if (it != g_streams.end())
        {
            s = it->second;
        }
    }

    if (s)
    {
        s->paused.store(false);
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
        if (it != g_streams.end())
        {
            s = it->second;
        }
    }

    if (!s)
        return env.Null();

    {
        std::unique_lock<std::mutex> lock(s->ringMutex);
        s->ringCv.wait(lock, [s]() {
            return s->ring.availableToRead() == 0 || !s->running.load();
        });
    }

    return env.Undefined();
}

static Napi::Value GetLastErrorJs(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    (void)info;
    return Napi::String::New(env, g_lastError);
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
    exports.Set("pause", Napi::Function::New(env, Pause));
    exports.Set("resume", Napi::Function::New(env, Resume));
    exports.Set("drain", Napi::Function::New(env, Drain));
    exports.Set("getLastError", Napi::Function::New(env, GetLastErrorJs));
    return exports;
}

NODE_API_MODULE(exclusive_audio, InitAll)