{
  "targets": [
    {
      "target_name": "exclusive_audio",
      "sources": [
        "src/exclusive_audio.cc"
      ],
      "include_dirs": [
        "<!(node -e \"console.log(require('node-addon-api').include_dir)\")"
      ],
      "dependencies": [
        "<!(node -e \"console.log(require('node-addon-api').gyp)\")"
      ],
      "cflags_cc": [
        "-std=c++17"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "conditions": [
        [ "OS=='win'", {
          "defines": [ "EXCLUSIVE_WIN32" ],
          "libraries": [
            "ole32.lib",
            "avrt.lib"
          ]
        }],
        [ "OS=='mac'", {
          "defines": [ "EXCLUSIVE_MACOS" ],
          "xcode_settings": {
            "OTHER_LDFLAGS": [
              "-framework", "CoreAudio",
              "-framework", "AudioUnit",
              "-framework", "AudioToolbox",
              "-framework", "CoreFoundation",
              "-framework", "CoreServices"
            ]
          }
        }],
        [ "OS=='linux'", {
          "defines": [ "EXCLUSIVE_LINUX" ],
          "libraries": [
            "-lasound"
          ]
        }]
      ]
    }
  ]
}