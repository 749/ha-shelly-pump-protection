# Shelly Plus 1PM Pump Protection for Home Assistant

Local pump safety for a **Shelly Plus 1PM**, coordinated by **Home Assistant**
and the **OpenWeatherMap Free APIs**.

The design deliberately keeps the critical enforcement on the Shelly:

- frost lock disables the physical input and forces the pump off;
- every pump start marks the water lines as **not purged**;
- automatic shutdown stops the pump once useful pumping has ended;
- a maximum runtime limits how long the relay can remain on;
- Home Assistant supplies current/forecast weather, configuration and alerts;
- the Shelly retains its configuration/state in KVS if Home Assistant or the
  network is unavailable.

## Features

| Feature | Default | Enforced by |
| --- | ---: | --- |
| Frost cutoff | `< 4 °C` | HA decides, Shelly enforces |
| Frost hysteresis | `1 °C` | HA |
| Unlock temperature | `5 °C` with defaults | HA |
| Automatic shutdown threshold | `< 10 W` | Shelly |
| Automatic shutdown delay | `15 min` continuous | Shelly |
| Maximum runtime | `30 min` continuous | Shelly |
| Line purge invalidation | Every pump ON | Shelly |
| Forecast warning window | `24 h` | HA |
| Forecast reminder | Every 6 h while required | HA |

## Architecture

```text
                OpenWeatherMap Free API
                 /                    \
          "current" mode          "forecast" mode
          current weather         5d / 3h forecast
                 |                    |
                 +---------+----------+
                           |
                    Home Assistant
                           |
             +-------------+--------------+
             |                            |
     sync pump_config                forecast < cutoff
     set frost_lock                  + line_purged=false
             |                            |
             v                            v
       Shelly Plus 1PM               notify users
       +--------------+
       | pump_config  |  JSON configuration
       | frost_lock   |  boolean
       | line_purged  |  boolean
       +--------------+
             |
       local enforcement
       - lock physical input
       - force OFF during frost
       - automatic shutdown
       - maximum-runtime shutdown
       - invalidate purge state on pump ON
```

## Repository layout

```text
.
├── blueprints
│   ├── automation
│   │   └── shelly_plus_1pm_pump_protection.yaml
│   └── script
│       └── mark_water_lines_purged.yaml
├── examples
│   ├── dashboard-card.yaml
│   ├── dashboard-card.de.yaml
│   ├── dashboard-card.fr.yaml
│   ├── dashboard-card.es.yaml
│   └── notify-group.yaml
├── shelly
│   └── pump_protection.js
├── .gitignore
└── README.md
```

## Requirements

- Home Assistant with the built-in Shelly integration.
- A Shelly Plus 1PM (Gen2) with scripting enabled.
- Shelly firmware recent enough for the current Gen2 scripting/KVS API.
- Two OpenWeatherMap integration entries using the **Free** service:
  1. mode `current`
  2. mode `forecast`
- At least one Home Assistant notification entity.
- The pump must have a meaningful power draw above the configured automatic
  shutdown threshold during normal operation.

> [!IMPORTANT]
> This project is a convenience/safety automation, not certified frost,
> dry-run, electrical, or machinery protection. Do not use software automation
> as a substitute for protection required by the pump manufacturer or local
> electrical/plumbing rules.

## Why two OpenWeatherMap entities?

Home Assistant's OpenWeatherMap integration currently exposes these two
non-subscription Free modes separately:

- `current` — current weather only;
- `forecast` — 5-day forecast in 3-hour steps.

The One Call `v3.0` mode combines current and richer forecasts, but requires
activating a subscription (with a limited free tier). This repository
intentionally uses the two **Free** modes so no One Call subscription is
required.

You can normally use the same OpenWeatherMap API key for both integration
entries. Give them obvious names, for example:

```text
OpenWeatherMap Current
OpenWeatherMap Forecast
```

After adding them, verify that Home Assistant has two weather entities and
that the forecast entity responds to `weather.get_forecasts` with an hourly
forecast. The Free forecast data is still supplied in 3-hour increments.

## Installation

### 1. Configure OpenWeatherMap

Create an OpenWeatherMap API key.

In Home Assistant, go to:

```text
Settings -> Devices & services -> Add Integration -> OpenWeatherMap
```

Add the integration twice for the same coordinates/API key:

| Name | Mode |
| --- | --- |
| `OpenWeatherMap Current` | `current` |
| `OpenWeatherMap Forecast` | `forecast` |

New OpenWeatherMap keys can take some time to activate.

### 2. Install the Shelly script

Open the Shelly Plus 1PM web interface.

Go to **Scripts**, create a new script named `Pump Protection`, and paste the
contents of:

```text
shelly/pump_protection.js
```

Enable **Run on startup**, save, and start it.

On first startup the script creates conservative defaults if required:

```json
{
  "cutoff_c": 4,
  "hysteresis_c": 1,
  "automatic_shutdown_w": 10,
  "automatic_shutdown_seconds": 900,
  "maximum_runtime_seconds": 1800
}
```

It also initializes:

```text
line_purged = false
```

The `frost_lock` state is fail-safe: until Home Assistant has supplied a valid
state, the Shelly treats frost protection as active.

### 3. Install the blueprints

Copy:

```text
blueprints/automation/shelly_plus_1pm_pump_protection.yaml
```

to:

```text
/config/blueprints/automation/shelly_plus_1pm_pump_protection.yaml
```

Copy:

```text
blueprints/script/mark_water_lines_purged.yaml
```

to:

```text
/config/blueprints/script/mark_water_lines_purged.yaml
```

Reload automations/scripts or restart Home Assistant.

### 4. Create the pump-protection automation

First create two **Toggle** helpers named `Water Pump Frost Lock` and
`Water Lines Purged`. These expose the corresponding Shelly KVS states to
dashboards. The automation keeps both synchronized and treats unreadable
states as locked and not purged, respectively.

Create an automation from **Shelly Plus 1PM Pump Protection** and select:

- **OpenWeatherMap current weather**: the entity from `current` mode.
- **OpenWeatherMap forecast weather**: the entity from `forecast` mode.
- **Shelly Plus 1PM**: the pump Shelly.
- **Frost lock helper**: the frost-lock toggle helper created above.
- **Water lines purged helper**: the purge-state toggle helper created above.
- notification entities for everyone who should be warned.

Defaults are:

```text
Frost cutoff:             4 °C
Hysteresis:               1 °C
Automatic shutdown threshold:  10 W
Automatic shutdown delay:      15 min
Maximum runtime:                30 min
Forecast look-ahead:     24 h
```

Run the automation once after creating/changing it if you want the new
configuration pushed to the Shelly immediately. Otherwise its 5-minute
reconciliation trigger will synchronize it automatically.

### 5. Create the manual purge script

Create a script from the **Mark Shelly Pump Water Lines Purged** blueprint.

Select the same Shelly, its pump switch, and the `Water Lines Purged` helper.

Add that script to your dashboard as a button. The script refuses the write
while the pump relay is ON.

The example dashboard card conditionally shows the pump switch only while the
frost-lock helper is off. Otherwise it displays a frost-protection warning.
The purge button is shown only while the water-lines-purged helper is off.
Localized examples are provided for English (`dashboard-card.yaml`), German
(`dashboard-card.de.yaml`), French (`dashboard-card.fr.yaml`), and Spanish
(`dashboard-card.es.yaml`). Replace all example entity IDs before use.

The purge workflow is:

```text
pump OFF
   |
manually purge plumbing
   |
press "Mark water lines purged"
   |
line_purged=true on Shelly
```

The next pump start, regardless of whether it came from the physical input,
Home Assistant, Shelly Web UI, or RPC, sets:

```text
line_purged=false
```

## Shelly KVS

### `pump_config`

Home Assistant owns this value and rewrites the complete object regularly:

```json
{
  "cutoff_c": 4,
  "hysteresis_c": 1,
  "automatic_shutdown_w": 10,
  "automatic_shutdown_seconds": 900,
  "maximum_runtime_seconds": 1800
}
```

This keeps all user-facing configuration together on the device.

### `frost_lock`

Boolean written by Home Assistant:

```text
true
```

means:

- physical input is locked;
- relay is forced OFF;
- attempts to turn the relay on are immediately counteracted.

Current-temperature behavior with the defaults:

```text
T < 4 °C        -> frost_lock=true
4 <= T < 5 °C   -> preserve previous state
T >= 5 °C       -> frost_lock=false
weather unknown -> frost_lock=true
```

### `line_purged`

Boolean representing whether the plumbing has been manually purged.

The Shelly is the source of truth.

```text
pump turns ON -> false
manual purge + HA button while pump OFF -> true
```

An automatic shutdown does **not** mark the lines purged.

## Automatic shutdown

While the relay is ON, the Shelly samples active power every five seconds.

With the defaults:

```text
power < 10 W continuously for 15 minutes -> relay OFF
```

If power rises to `>= 10 W` at any point, the timer resets.

For example:

```text
8 W   for 10 min
120 W for 30 sec
7 W   for 14 min
```

does **not** shut the pump down because the 120 W interval reset the timer.

If the power measurement is missing/invalid, the timer is also reset rather
than treating the measurement as `0 W`.

## Maximum runtime

The maximum-runtime timer uses only the relay state. With the default
configuration, one continuous 16-hour relay-on period turns the relay off. It
does not depend on measured power, detected pumping activity, or water flow.
This provides a final limit when a leak or continuous demand prevents automatic
shutdown.

Turning the pump off resets both timers. Changing any automatic-shutdown or
maximum-runtime setting also resets them.

## Forecast purge warning

The automation requests forecast data from the separate OpenWeatherMap
`forecast` entity.

If any forecast point inside the configured look-ahead window is below the
**same frost cutoff** and:

```text
line_purged == false
```

all selected notify entities receive a warning.

Warnings are evaluated:

- when the forecast weather entity changes;
- at Home Assistant startup;
- every six hours as a reminder.

The 5-minute configuration reconciliation intentionally does not send purge
notifications.

## Notifications to all users

The recommended approach is a Home Assistant Notify Group containing each
user's Companion App notification target, then select that group/entity in the
blueprint.

An example for legacy service-style notification groups is included at:

```text
examples/notify-group.yaml
```

Modern notify entities can also be grouped through Home Assistant's Helpers UI.

## Fail-safe behavior

### Home Assistant unavailable

The Shelly keeps:

- the last `pump_config`;
- the last `frost_lock`;
- the current `line_purged`.

Automatic shutdown, maximum-runtime protection, and purge invalidation
continue locally.

### `frost_lock` missing/unreadable

The Shelly assumes frost protection is active and forces the pump off.

### Current weather unavailable

Home Assistant writes `frost_lock=true`.

### Forecast unavailable

No forecast-based purge notification can be generated. This does not disable
the current-temperature frost lock.

### Power measurement unavailable

The automatic-shutdown timer resets. A missing reading cannot cause a false
automatic shutdown. The independent maximum-runtime timer continues.

## Testing

Do these tests before relying on the setup.

1. **KVS synchronization**
   - Run the HA automation.
   - Inspect `pump_config` on the Shelly.
   - Confirm all five values match the blueprint settings.

2. **Physical frost lock**
   - Temporarily set the frost cutoff above the current outside temperature.
   - Run the automation.
   - Confirm `frost_lock=true`.
   - Confirm the physical input no longer starts the pump.

3. **HA/RPC frost lock**
   - While frost-locked, try switching the pump on from HA.
   - Confirm the relay is forced back off.

4. **Purge invalidation**
   - With pump OFF, run the purge script.
   - Confirm `line_purged=true`.
   - Start the pump.
   - Confirm `line_purged=false`.

5. **Automatic shutdown**
   - Use a safe test value significantly above the pump's actual consumption
     and a short timeout.
   - Confirm the Shelly turns the relay off.
   - Restore the intended settings immediately afterward.

6. **Maximum runtime**
   - Temporarily select a short runtime and run the pump under safe conditions.
   - Confirm the Shelly turns the relay off at the configured limit.
   - Restore the intended setting immediately afterward.

7. **Forecast warning**
   - Temporarily raise the cutoff above a forecast temperature.
   - Set `line_purged=false`.
   - Trigger the automation/forecast check and verify notifications.

> [!WARNING]
> Do not perform an automatic-shutdown test in a way that could damage the
> pump, run it dry, freeze plumbing, or defeat manufacturer protections.

## Git

The downloadable directory is already initialized as a Git repository.

Add your remote and push it:

```bash
git remote add origin git@YOUR_GIT_SERVER:YOUR_USER/ha-shelly-pump-protection.git
git push -u origin main
```

## References

- Home Assistant OpenWeatherMap integration:
  https://www.home-assistant.io/integrations/openweathermap/
- Home Assistant Shelly integration:
  https://www.home-assistant.io/integrations/shelly/
- Shelly KVS API:
  https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/KVS/
- Shelly Switch API:
  https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/
