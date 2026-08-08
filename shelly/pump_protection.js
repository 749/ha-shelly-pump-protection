// Shelly Plus 1PM - Pump Protection
//
// Local safety functions:
//   - Frost lock enforcement
//   - Physical input lock while frost protection is active
//   - Water-line purge state tracking
//   - Automatic shutdown after sustained low consumption
//   - Maximum relay-on-time shutdown
//
// KVS keys:
//
// pump_config:
// {
//   "cutoff_c": 4,
//   "hysteresis_c": 1,
//   "automatic_shutdown_w": 10,
//   "automatic_shutdown_seconds": 900,
//   "maximum_runtime_seconds": 57600
// }
//
// frost_lock:
//   true / false
//
// line_purged:
//   true / false
//
// Home Assistant owns/synchronizes pump_config and frost_lock.
// The Shelly owns line_purged and invalidates it whenever the pump turns on.

let SWITCH_ID = 0;

let CONFIG_KEY = "pump_config";
let FROST_KEY = "frost_lock";
let PURGED_KEY = "line_purged";

let DEFAULT_CONFIG = JSON.stringify({
  cutoff_c: 4,
  hysteresis_c: 1,
  automatic_shutdown_w: 10,
  automatic_shutdown_seconds: 900,
  maximum_runtime_seconds: 57600
});

let config = DEFAULT_CONFIG;
let frostLocked = true;

let readingConfig = false;
let readingFrostState = false;

let automaticShutdownMs = 0;
let runtimeMs = 0;

let POWER_CHECK_INTERVAL_MS = 5000;
let CONFIG_CHECK_INTERVAL_MS = 10000;
let FROST_CHECK_INTERVAL_MS = 2000;

function logError(operation, errorCode, errorMessage) {
  console.log(operation + " failed:", errorCode, errorMessage);
}

function setKvs(key, value) {
  Shelly.call(
    "KVS.Set",
    {
      key: key,
      value: value
    },
    function(result, errorCode, errorMessage) {
      if (errorCode !== 0) {
        logError("KVS.Set(" + key + ")", errorCode, errorMessage);
      }
    }
  );
}

function isNumber(value) {
  return typeof value === "number" && isFinite(value);
}

function applyConfig(value) {
  if (value === null || typeof value !== "object") {
    value = JSON.parse(value);
  }
  if (value === null || typeof value !== "object") {
    console.log("Invalid pump_config: expected object");
    return false;
  }

  if (
    !isNumber(value.cutoff_c) ||
    !isNumber(value.hysteresis_c) ||
    !isNumber(value.automatic_shutdown_w) ||
    !isNumber(value.automatic_shutdown_seconds) ||
    !isNumber(value.maximum_runtime_seconds)
  ) {
    console.log("Invalid pump_config: missing or non-numeric field");
    return false;
  }

  if (
    value.hysteresis_c < 0 ||
    value.automatic_shutdown_w < 0 ||
    value.automatic_shutdown_seconds <= 0 ||
    value.maximum_runtime_seconds <= 0
  ) {
    console.log("Invalid pump_config: value outside allowed range");
    return false;
  }

  let timersChanged =
    config.automatic_shutdown_w !== value.automatic_shutdown_w ||
    config.automatic_shutdown_seconds !== value.automatic_shutdown_seconds ||
    config.maximum_runtime_seconds !== value.maximum_runtime_seconds;

  config = {
    cutoff_c: value.cutoff_c,
    hysteresis_c: value.hysteresis_c,
    automatic_shutdown_w: value.automatic_shutdown_w,
    automatic_shutdown_seconds: value.automatic_shutdown_seconds,
    maximum_runtime_seconds: value.maximum_runtime_seconds
  };

  // Do not carry elapsed time across a timer configuration change.
  if (timersChanged) {
    automaticShutdownMs = 0;
    runtimeMs = 0;
  }

  console.log("Configuration:", JSON.stringify(config));
  return true;
}

function updateConfig() {
  if (readingConfig) {
    return;
  }

  readingConfig = true;

  Shelly.call(
    "KVS.Get",
    { key: CONFIG_KEY },
    function(result, errorCode, errorMessage) {
      readingConfig = false;

      if (errorCode !== 0 || result === null || !applyConfig(result.value)) {
        console.log("pump_config missing/invalid; keeping current/default config");
      }
    }
  );
}

function enforceFrostState() {
  let switchConfig = Shelly.getComponentConfig("switch:" + SWITCH_ID);
  let status = Shelly.getComponentStatus("switch:" + SWITCH_ID);

  // Lock the physical input while frost protection is active.
  if (switchConfig !== null && switchConfig.in_locked !== frostLocked) {
    console.log("Physical input:", frostLocked ? "LOCKED" : "UNLOCKED");

    Shelly.call(
      "Switch.SetConfig",
      {
        id: SWITCH_ID,
        config: {
          in_locked: frostLocked
        }
      },
      function(result, errorCode, errorMessage) {
        if (errorCode !== 0) {
          logError("Switch.SetConfig", errorCode, errorMessage);
        }
      }
    );
  }

  // Network/API attempts may still switch the relay. Force it back off.
  if (frostLocked && status !== null && status.output === true) {
    console.log("Frost lock active -> forcing pump OFF");
    automaticShutdownMs = 0;
    runtimeMs = 0;

    Shelly.call(
      "Switch.Set",
      {
        id: SWITCH_ID,
        on: false
      },
      function(result, errorCode, errorMessage) {
        if (errorCode !== 0) {
          logError("Switch.Set frost shutdown", errorCode, errorMessage);
        }
      }
    );
  }
}

function updateFrostState() {
  if (readingFrostState) {
    return;
  }

  readingFrostState = true;

  Shelly.call(
    "KVS.Get",
    { key: FROST_KEY },
    function(result, errorCode, errorMessage) {
      readingFrostState = false;

      // Missing/unreadable frost state fails safe.
      if (errorCode !== 0 || result === null) {
        if (!frostLocked) {
          console.log("frost_lock unavailable -> FAIL-SAFE LOCK");
        }

        frostLocked = true;
        enforceFrostState();
        return;
      }

      let newState = result.value === true;

      if (newState !== frostLocked) {
        frostLocked = newState;
        console.log(
          "Frost protection:",
          frostLocked ? "ACTIVE" : "INACTIVE"
        );
      }

      enforceFrostState();
    }
  );
}

function pumpTurnedOn() {
  // Requirement: any ON cycle invalidates the manual purge state.
  console.log("Pump ON -> line_purged=false");
  setKvs(PURGED_KEY, false);

  automaticShutdownMs = 0;
  runtimeMs = 0;

  if (frostLocked) {
    console.log("Pump operation blocked by frost protection");

    Shelly.call(
      "Switch.Set",
      {
        id: SWITCH_ID,
        on: false
      },
      function(result, errorCode, errorMessage) {
        if (errorCode !== 0) {
          logError("Switch.Set frost block", errorCode, errorMessage);
        }
      }
    );
  }
}

function pumpTurnedOff() {
  automaticShutdownMs = 0;
  runtimeMs = 0;
}

Shelly.addStatusHandler(function(status) {
  if (
    status.component !== "switch:" + SWITCH_ID ||
    status.delta === undefined
  ) {
    return;
  }

  if (status.delta.output === true) {
    pumpTurnedOn();
  } else if (status.delta.output === false) {
    pumpTurnedOff();
  }
});

function checkPumpSafety() {
  let status = Shelly.getComponentStatus("switch:" + SWITCH_ID);

  if (status === null || status.output !== true) {
    automaticShutdownMs = 0;
    runtimeMs = 0;
    return;
  }

  runtimeMs += POWER_CHECK_INTERVAL_MS;

  if (runtimeMs >= config.maximum_runtime_seconds * 1000) {
    console.log(
      "MAXIMUM-RUNTIME SHUTDOWN: relay remained ON for",
      config.maximum_runtime_seconds,
      "s"
    );

    automaticShutdownMs = 0;
    runtimeMs = 0;

    Shelly.call(
      "Switch.Set",
      { id: SWITCH_ID, on: false },
      function(result, errorCode, errorMessage) {
        if (errorCode !== 0) {
          logError("Switch.Set maximum-runtime shutdown", errorCode, errorMessage);
        }
      }
    );
    return;
  }

  // A missing/invalid measurement must not be interpreted as zero watts.
  if (status.apower === undefined || !isNumber(status.apower)) {
    automaticShutdownMs = 0;
    return;
  }

  if (status.apower < config.automatic_shutdown_w) {
    automaticShutdownMs += POWER_CHECK_INTERVAL_MS;

    let elapsedSeconds = Math.floor(automaticShutdownMs / 1000);

    if (elapsedSeconds % 60 === 0 || elapsedSeconds === 5) {
      console.log(
        "Automatic shutdown:",
        status.apower,
        "W for",
        elapsedSeconds,
        "s; cutoff",
        config.automatic_shutdown_w,
        "W /",
        config.automatic_shutdown_seconds,
        "s"
      );
    }

    if (elapsedSeconds >= config.automatic_shutdown_seconds) {
      console.log(
        "AUTOMATIC SHUTDOWN:",
        status.apower,
        "W remained below",
        config.automatic_shutdown_w,
        "W for",
        config.automatic_shutdown_seconds,
        "s"
      );

      automaticShutdownMs = 0;

      Shelly.call(
        "Switch.Set",
        {
          id: SWITCH_ID,
          on: false
        },
        function(result, errorCode, errorMessage) {
          if (errorCode !== 0) {
            logError("Switch.Set automatic shutdown", errorCode, errorMessage);
          }
        }
      );
    }
  } else {
    if (automaticShutdownMs > 0) {
      console.log(
        "Power recovered to",
        status.apower,
        "W -> resetting automatic-shutdown timer"
      );
    }

    automaticShutdownMs = 0;
  }
}

function initializePurgeState() {
  Shelly.call(
    "KVS.Get",
    { key: PURGED_KEY },
    function(result, errorCode, errorMessage) {
      if (errorCode !== 0 || result === null) {
        console.log("line_purged missing -> initializing false");
        setKvs(PURGED_KEY, false);
      }
    }
  );
}

function initializeConfig() {
  Shelly.call(
    "KVS.Get",
    { key: CONFIG_KEY },
    function(result, errorCode, errorMessage) {
      if (errorCode !== 0 || result === null || !applyConfig(result.value)) {
        console.log("pump_config missing/invalid -> writing defaults");
        config = DEFAULT_CONFIG;
        setKvs(CONFIG_KEY, DEFAULT_CONFIG);
      }
    }
  );
}

// Fail safe until frost_lock has been successfully read.
frostLocked = true;
automaticShutdownMs = 0;
runtimeMs = 0;

initializePurgeState();
initializeConfig();
updateFrostState();
enforceFrostState();

Timer.set(
  FROST_CHECK_INTERVAL_MS,
  true,
  function() {
    updateFrostState();
  }
);

Timer.set(
  CONFIG_CHECK_INTERVAL_MS,
  true,
  function() {
    updateConfig();
  }
);

Timer.set(
  POWER_CHECK_INTERVAL_MS,
  true,
  function() {
    checkPumpSafety();
  }
);

console.log("Pump protection script started");
