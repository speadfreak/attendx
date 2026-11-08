/*
 * AttendX Phase 4 — Gate Integrity Validator firmware (Arduino Uno)
 * ==================================================================
 *
 * Two physical sensors watch the gate; every "one body passed" moment is
 * streamed to the Raspberry Pi over USB serial as a JSON line. The Pi
 * batches events to /api/gate/sensor-events where the cross-validation
 * engine compares them against camera-matched attendance.
 *
 * WIRING (5V logic — the Uno talks to the Pi ONLY over USB serial, so no
 * level shifter is needed on the Pi side):
 *
 *   HC-SR04 ultrasonic (facing across the gate opening):
 *     VCC  → 5V
 *     TRIG → D7
 *     ECHO → D8
 *     GND  → GND
 *
 *   IR break-beam pair stretched across the gate width:
 *     EMITTER  → 5V (through the module, or 330Ω series resistor for a
 *                bare IR LED) aimed at the receiver
 *     RECEIVER OUT → D2  (must be HIGH when beam is clear, LOW when the
 *                beam is broken — true for standard break-beam receiver
 *                modules and for a TSOP38238 whose output drops while it
 *                sees the 38 kHz carrier... NOTE: a TSOP idles HIGH and
 *                pulses LOW on carrier; sustained loss = beam blocked.)
 *     VCC → 5V, GND → GND
 *
 *   STATUS LED → D13 (onboard): slow heartbeat blink = running;
 *                triple-flash = pass event emitted.
 *
 * SERIAL PROTOCOL (9600 baud, newline-terminated JSON lines):
 *   out: {"sensor":"ultrasonic","ts":123456,"event":"pass"}
 *        {"sensor":"ir_beam","ts":124567,"event":"pass"}
 *        {"sensor":"status","event":"snapshot",...}   (reply to STATUS)
 *   in:  STATUS            → one-line JSON snapshot of both sensors
 *        THRESH <cm>       → ultrasonic trigger threshold (20..200, default 80)
 *        GAPU <ms>         → ultrasonic debounce gap (default 2000)
 *        GAPI <ms>         → IR debounce gap (default 1000)
 *
 * PASS-DETECTION LOGIC
 *   ultrasonic: a pass = distance drops below THRESH (body enters the
 *     cone) then recovers above THRESH + HYSTERESIS_CM within MAX_DWELL_MS.
 *     One pass per recovery; GAPU enforces the minimum gap between events
 *     so one person can never be counted twice from jitter.
 *   ir_beam: a pass = beam broken (LOW) for BREAK_MIN..BREAK_MAX ms, then
 *     released. GAPI enforces the debounce gap.
 *
 * Both sensors debounce independently — the same body breaking both beams
 * still produces exactly two events (one per sensor), which is exactly
 * what the server-side three-way comparison expects.
 */

const unsigned long SERIAL_BAUD = 9600;

// ── Pins ────────────────────────────────────────────────────────
const int PIN_TRIG = 7;   // HC-SR04 TRIG
const int PIN_ECHO = 8;   // HC-SR04 ECHO
const int PIN_IR   = 2;   // IR break-beam receiver OUT (HIGH = clear)
const int PIN_LED  = 13;  // onboard status LED

// ── Tunables (runtime-adjustable via serial commands) ──────────
int enterThresholdCm = 80;             // body closer than this = in the cone
const int HYSTERESIS_CM = 15;          // must recover above THRESH + this
const unsigned long MAX_DWELL_MS = 8000;   // longer than this = parked, not passing
const unsigned long BREAK_MIN_MS = 30;     // shorter than this = noise
const unsigned long BREAK_MAX_MS = 3000;   // longer than this = blocked/parked
unsigned long minGapUltrasonicMs = 2000;   // debounce: ultrasonic
unsigned long minGapIrMs = 1000;           // debounce: IR

// ── Ultrasonic state machine ────────────────────────────────────
bool ultraOccupied = false;
unsigned long ultraEnteredAt = 0;
unsigned long lastUltrasonicPassAt = 0;
unsigned long lastPingAt = 0;
int lastDistanceCm = 999;

// ── IR state machine ────────────────────────────────────────────
bool irBroken = false;
unsigned long irBrokenAt = 0;
unsigned long lastIrPassAt = 0;

// ── LED heartbeat ───────────────────────────────────────────────
unsigned long lastBlinkAt = 0;
bool blinkState = false;
int flashPending = 0;          // pass-event flash counter
unsigned long lastFlashAt = 0;

unsigned long readDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(3);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  // 25ms timeout ≈ 4.3m round trip; 0 = nothing in range
  unsigned long duration = pulseIn(PIN_ECHO, HIGH, 25000UL);
  if (duration == 0) return 0;
  return (unsigned long)(duration / 58UL);  // ~343m/s, divide by 2
}

void emitPass(const char* sensor) {
  Serial.print("{\"sensor\":\"");
  Serial.print(sensor);
  Serial.print("\",\"ts\":");
  Serial.print(millis());
  Serial.println(",\"event\":\"pass\"}");
}

void emitSnapshot() {
  Serial.print("{\"sensor\":\"status\",\"event\":\"snapshot\",\"thresholdCm\":");
  Serial.print(enterThresholdCm);
  Serial.print(",\"gapUltrasonicMs\":");
  Serial.print(minGapUltrasonicMs);
  Serial.print(",\"gapIrMs\":");
  Serial.print(minGapIrMs);
  Serial.print(",\"lastDistanceCm\":");
  Serial.print(lastDistanceCm);
  Serial.print(",\"irClear\":");
  Serial.print(digitalRead(PIN_IR) == HIGH ? "true" : "false");
  Serial.println("}");
}

void handleCommand(const String& line) {
  String cmd = line;
  cmd.trim();
  if (cmd.length() == 0) return;
  if (cmd.equalsIgnoreCase("STATUS")) {
    emitSnapshot();
    return;
  }
  int space = cmd.indexOf(' ');
  if (space < 0) return;
  String name = cmd.substring(0, space);
  name.trim();
  long value = cmd.substring(space + 1).trim().toInt();
  if (name.equalsIgnoreCase("THRESH") && value >= 20 && value <= 200) {
    enterThresholdCm = (int)value;
  } else if (name.equalsIgnoreCase("GAPU") && value >= 200 && value <= 30000) {
    minGapUltrasonicMs = (unsigned long)value;
  } else if (name.equalsIgnoreCase("GAPI") && value >= 100 && value <= 30000) {
    minGapIrMs = (unsigned long)value;
  }
}

void setup() {
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_IR, INPUT);        // break-beam modules drive HIGH/LOW; if your
                                 // module is open-collector, change to INPUT_PULLUP
  pinMode(PIN_LED, OUTPUT);
  Serial.begin(SERIAL_BAUD);
  Serial.println("{\"sensor\":\"status\",\"event\":\"boot\",\"fw\":\"gate-validator-1.0\"}");
}

void loop() {
  unsigned long now = millis();

  // ── serial commands ──
  static String commandBuffer = "";
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n') {
      handleCommand(commandBuffer);
      commandBuffer = "";
    } else if (c != '\r') {
      commandBuffer += c;
      if (commandBuffer.length() > 64) commandBuffer = "";
    }
  }

  // ── ultrasonic pass detection (runs every 60ms) ──
  if (now - lastPingAt >= 60) {
    lastPingAt = now;
    int distance = readDistanceCm();
    if (distance > 0) lastDistanceCm = distance;

    if (!ultraOccupied) {
      if (lastDistanceCm > 0 && lastDistanceCm < enterThresholdCm) {
        ultraOccupied = true;
        ultraEnteredAt = now;
      }
    } else {
      bool recovered = lastDistanceCm == 0 || lastDistanceCm > enterThresholdCm + HYSTERESIS_CM;
      unsigned long dwell = now - ultraEnteredAt;
      if (recovered && dwell <= MAX_DWELL_MS) {
        if (now - lastUltrasonicPassAt >= minGapUltrasonicMs) {
          emitPass("ultrasonic");
          lastUltrasonicPassAt = now;
          flashPending = 3;
        }
        ultraOccupied = false;
      } else if (dwell > MAX_DWELL_MS) {
        // someone is standing in the cone — wait, don't count
        ultraOccupied = false;
      }
    }
  }

  // ── IR break-beam pass detection ──
  bool irClear = digitalRead(PIN_IR) == HIGH;
  if (!irBroken) {
    if (!irClear) {
      irBroken = true;
      irBrokenAt = now;
    }
  } else if (irClear) {
    unsigned long breakMs = now - irBrokenAt;
    if (breakMs >= BREAK_MIN_MS && breakMs <= BREAK_MAX_MS) {
      if (now - lastIrPassAt >= minGapIrMs) {
        emitPass("ir_beam");
        lastIrPassAt = now;
        flashPending = 3;
      }
    }
    irBroken = false;
  }

  // ── status LED ──
  if (flashPending > 0) {
    if (now - lastFlashAt >= 60) {
      lastFlashAt = now;
      blinkState = !blinkState;
      digitalWrite(PIN_LED, blinkState ? HIGH : LOW);
      if (!blinkState) flashPending -= 1;
    }
  } else if (now - lastBlinkAt >= 1200) {
    lastBlinkAt = now;
    blinkState = !blinkState;
    digitalWrite(PIN_LED, blinkState ? HIGH : LOW);
  }
}
