import AVFAudio
import Foundation

/// Audio Ducker CLI for OpenWhispr
/// Uses AVAudioEngine voice processing to trigger system-level audio ducking.
/// This mimics how FaceTime/WhatsApp duck other audio during calls.
///
/// Usage:
///   macos-audio-ducker start [--level min|default|mid|max] [--advanced]
///   macos-audio-ducker stop
///
/// Output:
///   DUCKING_STARTED - when ducking is active
///   DUCKING_STOPPED - when ducking is stopped
///   ERROR: <message> - on failure

class AudioDucker {
    private var audioEngine: AVAudioEngine?
    private var isActive = false

    enum DuckingLevel: String {
        case min = "min"
        case `default` = "default"
        case mid = "mid"
        case max = "max"

        @available(macOS 14.0, *)
        var avLevel: AVAudioVoiceProcessingOtherAudioDuckingConfiguration.Level {
            switch self {
            case .min: return .min
            case .default: return .default
            case .mid: return .mid
            case .max: return .max
            }
        }
    }

    func startDucking(level: DuckingLevel = .default, advancedDucking: Bool = false) -> Bool {
        guard !isActive else {
            return true // Already running
        }

        // Check macOS version - ducking configuration requires macOS 14+
        if #available(macOS 14.0, *) {
            return startWithVoiceProcessing(level: level, advancedDucking: advancedDucking)
        } else {
            // Fallback for older macOS - just enable voice processing without config
            return startWithBasicVoiceProcessing()
        }
    }

    @available(macOS 14.0, *)
    private func startWithVoiceProcessing(level: DuckingLevel, advancedDucking: Bool) -> Bool {
        do {
            audioEngine = AVAudioEngine()
            guard let engine = audioEngine else {
                fputs("ERROR: Failed to create audio engine\n", stderr)
                return false
            }

            let inputNode = engine.inputNode

            // Enable voice processing - this is required for ducking to work
            try inputNode.setVoiceProcessingEnabled(true)

            // Configure ducking
            let duckingConfig = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
                enableAdvancedDucking: ObjCBool(advancedDucking),
                duckingLevel: level.avLevel
            )
            inputNode.voiceProcessingOtherAudioDuckingConfiguration = duckingConfig

            // We need to connect something to make the engine valid
            // Use a dummy mixer node
            let format = inputNode.outputFormat(forBus: 0)
            engine.connect(inputNode, to: engine.mainMixerNode, format: format)

            // Mute the output so we don't hear the mic feedback
            engine.mainMixerNode.outputVolume = 0

            try engine.start()
            isActive = true
            return true

        } catch {
            fputs("ERROR: \(error.localizedDescription)\n", stderr)
            return false
        }
    }

    private func startWithBasicVoiceProcessing() -> Bool {
        do {
            audioEngine = AVAudioEngine()
            guard let engine = audioEngine else {
                fputs("ERROR: Failed to create audio engine\n", stderr)
                return false
            }

            let inputNode = engine.inputNode

            // Enable voice processing - even without config, this may trigger some ducking
            try inputNode.setVoiceProcessingEnabled(true)

            let format = inputNode.outputFormat(forBus: 0)
            engine.connect(inputNode, to: engine.mainMixerNode, format: format)
            engine.mainMixerNode.outputVolume = 0

            try engine.start()
            isActive = true
            return true

        } catch {
            fputs("ERROR: \(error.localizedDescription)\n", stderr)
            return false
        }
    }

    func stopDucking() {
        guard isActive, let engine = audioEngine else {
            return
        }

        engine.stop()
        audioEngine = nil
        isActive = false
    }
}

// MARK: - Main

func printUsage() {
    let usage = """
    Usage: macos-audio-ducker <command> [options]

    Commands:
      start   Start audio ducking
      stop    Stop audio ducking (sends signal to running instance)

    Options for 'start':
      --level <min|default|mid|max>   Ducking level (default: default)
      --advanced                       Enable advanced ducking (dynamic based on voice)

    Output:
      DUCKING_STARTED   Ducking is now active
      DUCKING_STOPPED   Ducking has stopped
      ERROR: <message>  An error occurred
    """
    print(usage)
}

func main() {
    let args = CommandLine.arguments

    guard args.count >= 2 else {
        printUsage()
        exit(1)
    }

    let command = args[1]

    switch command {
    case "start":
        // Parse options
        var level = AudioDucker.DuckingLevel.default
        var advancedDucking = false

        var i = 2
        while i < args.count {
            switch args[i] {
            case "--level":
                i += 1
                if i < args.count, let l = AudioDucker.DuckingLevel(rawValue: args[i]) {
                    level = l
                }
            case "--advanced":
                advancedDucking = true
            default:
                break
            }
            i += 1
        }

        let ducker = AudioDucker()

        if ducker.startDucking(level: level, advancedDucking: advancedDucking) {
            print("DUCKING_STARTED")
            fflush(stdout)

            // Handle termination signals
            let signalSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
            signal(SIGTERM, SIG_IGN)
            signalSource.setEventHandler {
                ducker.stopDucking()
                print("DUCKING_STOPPED")
                fflush(stdout)
                exit(0)
            }
            signalSource.resume()

            let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
            signal(SIGINT, SIG_IGN)
            sigintSource.setEventHandler {
                ducker.stopDucking()
                print("DUCKING_STOPPED")
                fflush(stdout)
                exit(0)
            }
            sigintSource.resume()

            // Keep running until terminated
            RunLoop.main.run()
        } else {
            fputs("ERROR: Failed to start audio ducking\n", stderr)
            exit(1)
        }

    case "stop":
        // This command doesn't do anything by itself - the parent process
        // should send SIGTERM to stop the running ducker
        print("Send SIGTERM to the running macos-audio-ducker process to stop ducking")
        exit(0)

    case "--help", "-h":
        printUsage()
        exit(0)

    default:
        fputs("Unknown command: \(command)\n", stderr)
        printUsage()
        exit(1)
    }
}

main()
