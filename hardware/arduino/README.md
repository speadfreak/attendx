# AttendX Arduino fan controller

The Uno reads a DHT22 temperature sensor and switches a relay module. It reports one JSON line over USB serial at 9600 baud for `STATUS` and `MODE AUTO|ON|OFF`. Automatic mode turns the fan on at 30°C and off at 27°C. A missing sensor reading defaults the relay to on.

## Wiring and safety

- DHT22: VCC to 5V, GND to GND, DATA to D2. Use a 10 kΩ DATA pull-up if the sensor board does not include one.
- Relay module logic: VCC to the module's rated logic supply, GND to Uno GND, IN to D8. Use a relay module with a transistor driver and flyback protection; do not connect a relay coil or fan directly to an Uno pin.
- Connect the fan's separate rated supply through the relay contacts. Do not power a fan from the Uno 5V pin. Mains-powered fans require a properly enclosed, rated relay and qualified electrical work; do not prototype mains wiring on a breadboard.
- Install the Arduino `DHT sensor library` and its `Adafruit Unified Sensor` dependency, select the Uno, compile, and upload `AttendXFanController.ino`.

## Test

Open Serial Monitor at 9600 baud with newline enabled. Send `STATUS`, `MODE ON`, `MODE OFF`, and `MODE AUTO`; each should return JSON. Warm the sensor gently to verify automatic switching and confirm the Pi Operations page receives temperature and fan state through `fan_telemetry` jobs.
