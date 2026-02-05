/**
 * Audio Ducking Manager for OpenWhispr
 *
 * Manages audio ducking during recording to lower/mute other audio sources.
 * Uses AVAudioEngine voice processing on macOS 14+ for system-level ducking,
 * with AppleScript fallback for older macOS or when native ducking fails.
 */

const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const { app } = require("electron");
const debugLogger = require("./debugLogger");

class AudioDuckingManager {
  constructor() {
    this.duckerProcess = null;
    this.isActive = false;
    this.savedVolumes = {
      music: null,
      spotify: null,
    };
    this.duckLevel = "default"; // min, default, mid, max
    this.useAdvancedDucking = false;
    this.fallbackMode = false;
  }

  /**
   * Get the path to the audio ducker binary
   */
  getBinaryPath() {
    const isPackaged = app.isPackaged;
    const resourcesPath = isPackaged
      ? process.resourcesPath
      : path.join(__dirname, "..", "..");

    // In development, binary is in resources/bin
    // In production, it's in the app.asar.unpacked or resources
    const binaryName = "macos-audio-ducker";
    const possiblePaths = [
      path.join(resourcesPath, "bin", binaryName),
      path.join(resourcesPath, "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    debugLogger.debug("Audio ducker binary not found in paths:", possiblePaths);
    return null;
  }

  /**
   * Check if native ducking is available (macOS only)
   */
  isNativeDuckingAvailable() {
    if (process.platform !== "darwin") {
      return false;
    }

    const binaryPath = this.getBinaryPath();
    return binaryPath !== null;
  }

  /**
   * Start audio ducking
   * @param {Object} options - Ducking options
   * @param {string} options.level - Ducking level: min, default, mid, max
   * @param {boolean} options.advanced - Use advanced (dynamic) ducking
   * @returns {Promise<boolean>} Success status
   */
  async startDucking(options = {}) {
    if (this.isActive) {
      debugLogger.debug("Audio ducking already active");
      return true;
    }

    const level = options.level || this.duckLevel;
    const advanced = options.advanced ?? this.useAdvancedDucking;

    // Try native ducking first on macOS
    if (process.platform === "darwin") {
      const nativeSuccess = await this.startNativeDucking(level, advanced);
      if (nativeSuccess) {
        return true;
      }
      debugLogger.debug("Native ducking failed, trying AppleScript fallback");
    }

    // Fallback to AppleScript for music apps
    return this.startAppleScriptDucking();
  }

  /**
   * Start native ducking using the Swift binary
   */
  async startNativeDucking(level, advanced) {
    const binaryPath = this.getBinaryPath();
    if (!binaryPath) {
      debugLogger.debug("Native audio ducker binary not available");
      return false;
    }

    return new Promise((resolve) => {
      try {
        const args = ["start", "--level", level];
        if (advanced) {
          args.push("--advanced");
        }

        debugLogger.debug("Starting native audio ducker", { binaryPath, args });

        this.duckerProcess = spawn(binaryPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
        });

        let started = false;

        this.duckerProcess.stdout.on("data", (data) => {
          const output = data.toString().trim();
          debugLogger.debug("Audio ducker output:", output);

          if (output.includes("DUCKING_STARTED") && !started) {
            started = true;
            this.isActive = true;
            this.fallbackMode = false;
            resolve(true);
          }
        });

        this.duckerProcess.stderr.on("data", (data) => {
          debugLogger.error("Audio ducker error:", data.toString());
        });

        this.duckerProcess.on("error", (err) => {
          debugLogger.error("Failed to start audio ducker:", err);
          this.duckerProcess = null;
          if (!started) {
            resolve(false);
          }
        });

        this.duckerProcess.on("exit", (code) => {
          debugLogger.debug("Audio ducker exited with code:", code);
          this.duckerProcess = null;
          this.isActive = false;
          if (!started) {
            resolve(false);
          }
        });

        // Timeout if ducking doesn't start within 3 seconds
        setTimeout(() => {
          if (!started) {
            debugLogger.debug("Native ducking timeout, process may have failed");
            this.stopNativeDucking();
            resolve(false);
          }
        }, 3000);
      } catch (err) {
        debugLogger.error("Error starting native ducking:", err);
        resolve(false);
      }
    });
  }

  /**
   * Stop native ducking
   */
  stopNativeDucking() {
    if (this.duckerProcess) {
      try {
        this.duckerProcess.kill("SIGTERM");
      } catch (err) {
        debugLogger.debug("Error killing ducker process:", err);
      }
      this.duckerProcess = null;
    }
  }

  /**
   * Start AppleScript-based ducking (fallback for older macOS)
   * Pauses Music.app and Spotify instead of volume ducking
   */
  async startAppleScriptDucking() {
    if (process.platform !== "darwin") {
      debugLogger.debug("AppleScript ducking only available on macOS");
      return false;
    }

    this.fallbackMode = true;
    const promises = [];

    // Check and pause Music.app
    promises.push(this.pauseMusicApp("Music", "music"));

    // Check and pause Spotify
    promises.push(this.pauseMusicApp("Spotify", "spotify"));

    try {
      const results = await Promise.all(promises);
      const anyPaused = results.some((r) => r);
      this.isActive = anyPaused || true; // Mark active even if nothing was playing
      debugLogger.debug("AppleScript ducking result:", { anyPaused });
      return true;
    } catch (err) {
      debugLogger.error("AppleScript ducking failed:", err);
      return false;
    }
  }

  /**
   * Pause a music app and save its state
   */
  async pauseMusicApp(appName, key) {
    return new Promise((resolve) => {
      // Check if app is running and playing
      const checkScript = `
        if application "${appName}" is running then
          tell application "${appName}"
            if player state is playing then
              return "playing"
            else
              return "not_playing"
            end if
          end tell
        else
          return "not_running"
        end if
      `;

      exec(`osascript -e '${checkScript}'`, (err, stdout) => {
        if (err) {
          debugLogger.debug(`Error checking ${appName}:`, err.message);
          resolve(false);
          return;
        }

        const state = stdout.trim();
        debugLogger.debug(`${appName} state:`, state);

        if (state === "playing") {
          // Pause the app
          const pauseScript = `tell application "${appName}" to pause`;
          exec(`osascript -e '${pauseScript}'`, (pauseErr) => {
            if (pauseErr) {
              debugLogger.debug(`Error pausing ${appName}:`, pauseErr.message);
              resolve(false);
            } else {
              this.savedVolumes[key] = "was_playing";
              debugLogger.debug(`Paused ${appName}`);
              resolve(true);
            }
          });
        } else {
          resolve(false);
        }
      });
    });
  }

  /**
   * Resume a previously paused music app
   */
  async resumeMusicApp(appName, key) {
    if (this.savedVolumes[key] !== "was_playing") {
      return;
    }

    return new Promise((resolve) => {
      const playScript = `
        if application "${appName}" is running then
          tell application "${appName}" to play
        end if
      `;

      exec(`osascript -e '${playScript}'`, (err) => {
        if (err) {
          debugLogger.debug(`Error resuming ${appName}:`, err.message);
        } else {
          debugLogger.debug(`Resumed ${appName}`);
        }
        this.savedVolumes[key] = null;
        resolve();
      });
    });
  }

  /**
   * Stop audio ducking and restore audio
   * @returns {Promise<void>}
   */
  async stopDucking() {
    if (!this.isActive) {
      return;
    }

    debugLogger.debug("Stopping audio ducking", { fallbackMode: this.fallbackMode });

    if (this.fallbackMode) {
      // Resume paused apps
      await Promise.all([
        this.resumeMusicApp("Music", "music"),
        this.resumeMusicApp("Spotify", "spotify"),
      ]);
    } else {
      // Stop native ducking
      this.stopNativeDucking();
    }

    this.isActive = false;
    this.fallbackMode = false;
  }

  /**
   * Get current ducking status
   */
  getStatus() {
    return {
      isActive: this.isActive,
      fallbackMode: this.fallbackMode,
      nativeAvailable: this.isNativeDuckingAvailable(),
    };
  }

  /**
   * Configure ducking settings
   */
  configure(options) {
    if (options.level) {
      this.duckLevel = options.level;
    }
    if (options.advanced !== undefined) {
      this.useAdvancedDucking = options.advanced;
    }
  }

  /**
   * Cleanup on app quit
   */
  cleanup() {
    this.stopDucking();
  }
}

module.exports = AudioDuckingManager;
