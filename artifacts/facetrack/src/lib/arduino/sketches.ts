/**
 * AttendX Gate Controller Studio — compilable Arduino sketches (Uno, 9600 8N1)
 * for the Phase 7 gate hardware. Each source carries its wiring table and the
 * exact arduino-cli compile line. The studio's compiler pipeline (server-side
 * arduino-cli or a local bridge) produces the .hex; the flasher burns it.
 */

export interface SketchCommand {
  /** Exact line the Control Terminal sends (newline appended). */
  cmd: string;
  /** Button label. */
  label: string;
  /** Optional tooltip explaining the command. */
  hint?: string;
}

export interface GateSketch {
  id: string;
  name: string;
  description: string;
  /** Suggested .ino basename when downloading from the studio. */
  filename: string;
  source: string;
  /** Serial commands this firmware understands — rendered as terminal macros. */
  commands?: SketchCommand[];
}

// String.raw keeps the C++ escape sequences (\", \n) byte-exact inside this
// TypeScript template literal.
const GATE_GEOFENCE_SOURCE = String.raw`// ============================================================================
// AttendX Gate Geofence Controller — Phase 7
// ============================================================================
// Target  : Arduino Uno / Nano (ATmega328P) @ 16 MHz
// Compile : arduino-cli compile --fqbn arduino:avr:uno
//
// Wiring (all 5 V logic, shared GND):
//   HC-SR04 ultrasonic   TRIG -> D7     ECHO -> D8     VCC -> 5V    GND -> GND
//   TSOP31238 IR         OUT  -> D2 (INT0, active LOW on 38 kHz bursts)
//                        VCC -> 5V (100 nF decoupling across VCC/GND), GND -> GND
//   Piezo buzzer         +    -> D5     - -> GND
//   Status LED           built-in D13
//
// Serial 9600 8N1 — machine lines the AttendX Gate Controller Studio (browser,
// over Web Serial) parses and batch-POSTs to /api/gate/sensor-events:
//   ATX1,{"gate":"MAIN","sensor":"ultrasonic","count":1,"ts":<millis>}
//   ATX1,{"gate":"MAIN","sensor":"ir_beam","code":"0xXXXXXXXX","count":1,"ts":<millis>}
// ts is millis() uptime; the Studio converts it to wall-clock on ingest.
//
// Serial command channel (the Studio's Control Terminal sends these, one per
// line, and every reply is an ATX1,{...} machine line):
//   PING                 -> {"type":"ack","pong":1}
//   STATUS               -> {"type":"status","distCm":..,"personCount":..}
//   DIST                 -> {"type":"ack","distCm":..}   one immediate read
//   BEEP [ms]            -> {"type":"ack","beepMs":..}   1..2000 ms blip
//   LED ON|OFF|BLINK     -> {"type":"ack","led":0|1}
//   THRESH <cm>          -> {"type":"ack","thresholdCm":..}  5..400 cm
//   COUNT RESET          -> {"type":"ack","personCount":0}
//   anything else        -> {"type":"error","error":"unknown cmd"}
//
// Loop design: fully non-blocking against loop() via millis() scheduling. The
// only bounded blocking call is pulseIn(..., 25000 us) inside the scheduled
// ultrasonic sweep (max 25 ms), so IR events never starve. The IR beam uses a
// 400 ms debounce, the ultrasonic beam-crossing uses the same window.
// ============================================================================

#include <Arduino.h>

// ---- pins ------------------------------------------------------------
const uint8_t PIN_TRIG = 7;
const uint8_t PIN_ECHO = 8;
const uint8_t PIN_IR   = 2;   // TSOP31238 -> INT0
const uint8_t PIN_BUZZ = 5;

// ---- tuning ----------------------------------------------------------
const unsigned long PING_INTERVAL_MS  = 60;     // HC-SR04 cycle >= 60 ms
const unsigned long ECHO_TIMEOUT_US   = 25000;  // ~4.3 m max range
const unsigned long EVENT_DEBOUNCE_MS = 400;    // shared 400 ms debounce
const uint16_t PERSON_DISTANCE_CM     = 120;    // beam-crossing threshold

// ---- IR (NEC) decoding on INT0, falling edges -------------------------
// TSOP31238 idles HIGH and pulls LOW during 38 kHz bursts. NEC frames are a
// 9 ms AGC burst + 4.5 ms space, then 32 bits: '0' = 560 us burst + 560 us
// space, '1' = 560 us burst + 1680 us space. Measuring falling-edge to
// falling-edge: header delta ~13.6 ms, '0' ~1.12 ms, '1' ~2.25 ms. NEC repeat
// frames (~11.8 ms delta) reset the decoder and emit nothing.
volatile uint32_t irLastEdgeUs = 0;
volatile uint8_t  irBitCount   = 0;
volatile uint32_t irShift      = 0;
volatile bool     irHaveCode   = false;
volatile uint32_t irCode       = 0;

void irIsr() {
  const uint32_t now = micros();
  const uint32_t delta = now - irLastEdgeUs;
  irLastEdgeUs = now;
  if (delta > 9000UL) {                              // header (AGC + space)
    irBitCount = 0;
    irShift = 0;
  } else if (delta > 2000UL && delta < 3000UL) {     // '1' (~2.25 ms)
    irShift = (irShift << 1) | 1UL;
    irBitCount++;
  } else if (delta > 800UL && delta < 1600UL) {      // '0' (~1.12 ms)
    irShift <<= 1;
    irBitCount++;
  } else {                                           // glitch — resync
    irBitCount = 0;
  }
  if (irBitCount == 32) {
    irCode = irShift;
    irHaveCode = true;
    irBitCount = 0;
  }
}

// ---- state -------------------------------------------------------------
bool          objPresent        = false;
unsigned long lastPingMs        = 0;
unsigned long lastUltrasonicMs  = 0;
unsigned long lastIrMs          = 0;
unsigned long buzzUntilMs       = 0;
uint32_t      personCount       = 0;

// ---- serial command channel (Control Terminal) -------------------------
char     cmdBuf[64];
uint8_t  cmdLen      = 0;
uint16_t thresholdCm = PERSON_DISTANCE_CM;

void printAck(const __FlashStringHelper* key, unsigned long value) {
  Serial.print(F("ATX1,{\"type\":\"ack\",\""));
  Serial.print(key);
  Serial.print(F("\":"));
  Serial.print(value);
  Serial.print(F(",\"ts\":"));
  Serial.print(millis());
  Serial.println(F("}"));
}

void emitStatus() {
  const unsigned long dur = pulseIn(PIN_ECHO, HIGH, ECHO_TIMEOUT_US);
  const uint16_t cm = (dur == 0) ? 0xFFFF : (uint16_t)(dur / 58UL);
  Serial.print(F("ATX1,{\"type\":\"status\",\"distCm\":"));
  Serial.print(cm);
  Serial.print(F(",\"personCount\":"));
  Serial.print(personCount);
  Serial.print(F(",\"thresholdCm\":"));
  Serial.print(thresholdCm);
  Serial.print(F(",\"ts\":"));
  Serial.print(millis());
  Serial.println(F("}"));
}

// strtok() tokenizes cmdBuf in place; all replies are ATX1 machine lines.
void handleCommand(char* line) {
  char* tok = strtok(line, " ");
  if (tok == NULL) return;
  if (strcasecmp(tok, "PING") == 0) {
    printAck(F("pong"), 1UL);
  } else if (strcasecmp(tok, "STATUS") == 0) {
    emitStatus();
  } else if (strcasecmp(tok, "DIST") == 0) {
    const unsigned long dur = pulseIn(PIN_ECHO, HIGH, ECHO_TIMEOUT_US);
    printAck(F("distCm"), dur == 0 ? 0xFFFFUL : dur / 58UL);
  } else if (strcasecmp(tok, "BEEP") == 0) {
    char* arg = strtok(NULL, " ");
    unsigned long ms = (arg != NULL) ? strtoul(arg, NULL, 10) : 120UL;
    if (ms == 0) ms = 120;
    if (ms > 2000) ms = 2000;
    tone(PIN_BUZZ, 2400);
    buzzUntilMs = millis() + ms;
    digitalWrite(LED_BUILTIN, HIGH);
    printAck(F("beepMs"), ms);
  } else if (strcasecmp(tok, "LED") == 0) {
    char* arg = strtok(NULL, " ");
    if (arg != NULL && strcasecmp(arg, "BLINK") == 0) {
      for (uint8_t i = 0; i < 3; i++) {
        digitalWrite(LED_BUILTIN, HIGH);
        delay(120);
        digitalWrite(LED_BUILTIN, LOW);
        delay(120);
      }
      printAck(F("led"), 0UL);
    } else {
      const bool on = (arg != NULL && strcasecmp(arg, "ON") == 0);
      digitalWrite(LED_BUILTIN, on ? HIGH : LOW);
      printAck(F("led"), on ? 1UL : 0UL);
    }
  } else if (strcasecmp(tok, "THRESH") == 0) {
    char* arg = strtok(NULL, " ");
    if (arg != NULL) {
      const long v = strtol(arg, NULL, 10);
      if (v >= 5 && v <= 400) thresholdCm = (uint16_t)v;
    }
    printAck(F("thresholdCm"), thresholdCm);
  } else if (strcasecmp(tok, "COUNT") == 0) {
    char* arg = strtok(NULL, " ");
    if (arg != NULL && strcasecmp(arg, "RESET") == 0) personCount = 0;
    printAck(F("personCount"), personCount);
  } else {
    Serial.print(F("ATX1,{\"type\":\"error\",\"error\":\"unknown cmd\",\"ts\":"));
    Serial.print(millis());
    Serial.println(F("}"));
  }
}

uint16_t readDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(4);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  const unsigned long dur = pulseIn(PIN_ECHO, HIGH, ECHO_TIMEOUT_US);
  if (dur == 0) return 0xFFFF;              // no echo this sweep
  return (uint16_t)(dur / 58UL);            // microseconds -> centimeters
}

void emitEvent(const __FlashStringHelper* sensor, uint32_t count, const char* code) {
  Serial.print(F("ATX1,{\"gate\":\"MAIN\",\"sensor\":\""));
  Serial.print(sensor);
  Serial.print(F("\","));
  if (code != NULL) {
    Serial.print(F("\"code\":\""));
    Serial.print(code);
    Serial.print(F("\","));
  }
  Serial.print(F("\"count\":"));
  Serial.print(count);
  Serial.print(F(",\"ts\":"));
  Serial.print(millis());
  Serial.println(F("}"));
}

void setup() {
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_BUZZ, OUTPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(PIN_TRIG, LOW);
  digitalWrite(PIN_BUZZ, LOW);
  Serial.begin(9600);
  attachInterrupt(digitalPinToInterrupt(PIN_IR), irIsr, FALLING);
}

void loop() {
  const unsigned long now = millis();

  // Serial command channel — char-at-a-time, bounded buffer, zero String.
  while (Serial.available() > 0) {
    const char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      cmdBuf[cmdLen] = '\0';
      if (cmdLen > 0) {
        handleCommand(cmdBuf);
        cmdLen = 0;
      }
      continue;
    }
    if (cmdLen < sizeof(cmdBuf) - 1) {
      cmdBuf[cmdLen++] = c;
    } else {
      cmdLen = 0;   // overflow — drop the buffer, resync on next newline
    }
  }

  // Non-blocking buzzer window.
  if (buzzUntilMs != 0 && now >= buzzUntilMs) {
    noTone(PIN_BUZZ);
    buzzUntilMs = 0;
    digitalWrite(LED_BUILTIN, LOW);
  }

  // Ultrasonic sweep, millis()-scheduled; one event per beam crossing.
  if (now - lastPingMs >= PING_INTERVAL_MS) {
    lastPingMs = now;
    const uint16_t cm = readDistanceCm();
    const bool present = (cm != 0xFFFF && cm <= thresholdCm);
    if (present && !objPresent && (now - lastUltrasonicMs >= EVENT_DEBOUNCE_MS)) {
      personCount++;
      lastUltrasonicMs = now;
      emitEvent(F("ultrasonic"), personCount, NULL);
      tone(PIN_BUZZ, 2400);
      buzzUntilMs = now + 90;
      digitalWrite(LED_BUILTIN, HIGH);
    }
    objPresent = present;
  }

  // IR beam events, flagged from the ISR, debounced 400 ms.
  if (irHaveCode) {
    noInterrupts();
    const uint32_t code = irCode;
    irHaveCode = false;
    interrupts();
    if (now - lastIrMs >= EVENT_DEBOUNCE_MS) {
      lastIrMs = now;
      char codeBuf[16];
      snprintf(codeBuf, sizeof(codeBuf), "0x%08lX", (unsigned long)code);
      emitEvent(F("ir_beam"), 1, codeBuf);
      tone(PIN_BUZZ, 1800);
      buzzUntilMs = now + 60;
      digitalWrite(LED_BUILTIN, HIGH);
    }
  }
}
`;

const IR_NODE_SOURCE = String.raw`// ============================================================================
// AttendX IR Receiver Node — NEC remote-code decoder
// ============================================================================
// Target  : Arduino Uno (ATmega328P) @ 16 MHz
// Compile : arduino-cli compile --fqbn arduino:avr:uno
//
// Wiring (5 V logic, shared GND):
//   TSOP31238 IR   OUT -> D2 (INT0)   VCC -> 5V (100 nF across VCC/GND)   GND -> GND
//   Piezo buzzer   +  -> D5          -  -> GND
//
// Serial 9600 8N1. Decodes NEC infrared remote codes (TV remotes work out of
// the box) and prints one line per accepted code, debounced to 400 ms:
//   ATX1,{"gate":"MAIN","sensor":"ir_beam","code":"0xXXXXXXXX","ts":<millis>}
// with a short confirmation beep. NEC repeat frames (holding a button down)
// are deliberately ignored — one beep per distinct press.
// ============================================================================

#include <Arduino.h>

const uint8_t PIN_IR   = 2;   // TSOP31238 -> INT0, active LOW on bursts
const uint8_t PIN_BUZZ = 5;
const unsigned long CODE_DEBOUNCE_MS = 400;

// ---- NEC decode on INT0, falling edges ---------------------------------
// Header: 9 ms AGC burst + 4.5 ms space (~13.6 ms falling-to-falling).
// Bits:   '0' ~1.12 ms, '1' ~2.25 ms. Repeat frame ~11.8 ms -> ignored.
volatile uint32_t irLastEdgeUs = 0;
volatile uint8_t  irBitCount   = 0;
volatile uint32_t irShift      = 0;
volatile bool     irHaveCode   = false;
volatile uint32_t irCode       = 0;

void irIsr() {
  const uint32_t now = micros();
  const uint32_t delta = now - irLastEdgeUs;
  irLastEdgeUs = now;
  if (delta > 9000UL) {                              // header (also kills repeats)
    irBitCount = 0;
    irShift = 0;
  } else if (delta > 2000UL && delta < 3000UL) {     // '1'
    irShift = (irShift << 1) | 1UL;
    irBitCount++;
  } else if (delta > 800UL && delta < 1600UL) {      // '0'
    irShift <<= 1;
    irBitCount++;
  } else {
    irBitCount = 0;                                  // glitch — resync
  }
  if (irBitCount == 32) {
    irCode = irShift;
    irHaveCode = true;
    irBitCount = 0;
  }
}

unsigned long buzzUntilMs = 0;
unsigned long lastCodeMs  = 0;

void setup() {
  pinMode(PIN_BUZZ, OUTPUT);
  digitalWrite(PIN_BUZZ, LOW);
  Serial.begin(9600);
  attachInterrupt(digitalPinToInterrupt(PIN_IR), irIsr, FALLING);
}

void loop() {
  const unsigned long now = millis();

  if (buzzUntilMs != 0 && now >= buzzUntilMs) {
    noTone(PIN_BUZZ);
    buzzUntilMs = 0;
  }

  if (irHaveCode) {
    noInterrupts();
    const uint32_t code = irCode;
    irHaveCode = false;
    interrupts();

    if (now - lastCodeMs >= CODE_DEBOUNCE_MS) {
      lastCodeMs = now;
      char codeBuf[16];
      snprintf(codeBuf, sizeof(codeBuf), "0x%08lX", (unsigned long)code);
      Serial.print(F("ATX1,{\"gate\":\"MAIN\",\"sensor\":\"ir_beam\",\"code\":\""));
      Serial.print(codeBuf);
      Serial.print(F("\",\"ts\":"));
      Serial.print(millis());
      Serial.println(F("}"));
      tone(PIN_BUZZ, 2000);
      buzzUntilMs = now + 70;
    }
  }
}
`;

const FAILSAFE_RELAY_SOURCE = String.raw`// ============================================================================
// AttendX Gate Failsafe Relay — serial JSON gate control
// ============================================================================
// Target  : Arduino Uno (ATmega328P) @ 16 MHz
// Compile : arduino-cli compile --fqbn arduino:avr:uno
//
// Wiring (5 V logic, shared GND):
//   Relay module  IN -> D12    VCC -> 5V    GND -> GND
//   (RELAY_ACTIVE_HIGH below matches typical "HIGH = closed contact" boards;
//    for active-LOW modules flip the constant.)
//
// Serial 9600 8N1. Accepts one JSON object per line:
//   {"cmd":"open"}   or   {"cmd":"close"}
// The parser is char-at-a-time with a bounded 64-byte buffer and zero String
// objects, so it is safe to feed over SoftwareSerial (or long bursts) without
// heap fragmentation. Emits a heartbeat every 5 s:
//   ATX1,{"gate":"MAIN","heartbeat":true,"relay":"open","ts":<millis>}
// and an ack line on every relay state change. Power-on default: closed.
// ============================================================================

#include <Arduino.h>

const uint8_t PIN_RELAY = 12;
const bool RELAY_ACTIVE_HIGH = true;
const unsigned long HEARTBEAT_MS = 5000;
const uint8_t CMD_BUF_SIZE = 64;

char cmdBuf[CMD_BUF_SIZE];
uint8_t cmdLen = 0;
bool relayOpen = false;
unsigned long lastHeartbeatMs = 0;

void relayWrite(bool openState) {
  relayOpen = openState;
  const bool energize = RELAY_ACTIVE_HIGH ? openState : !openState;
  digitalWrite(PIN_RELAY, energize ? HIGH : LOW);
}

void emitJson(bool heartbeat) {
  Serial.print(F("ATX1,{\"gate\":\"MAIN\","));
  if (heartbeat) {
    Serial.print(F("\"heartbeat\":true,"));
  }
  Serial.print(F("\"relay\":\""));
  Serial.print(relayOpen ? F("open") : F("close"));
  Serial.print(F("\",\"ts\":"));
  Serial.print(millis());
  Serial.println(F("}"));
}

// Minimal command matcher: find "cmd", then whichever of "open"/"close"
// appears first after it. No malloc, no String, no regex — SoftwareSerial-safe.
void handleCommand(const char* json) {
  const char* key = strstr(json, "\"cmd\"");
  if (key == NULL) return;
  const char* openMark = strstr(key, "\"open\"");
  const char* closeMark = strstr(key, "\"close\"");
  if (openMark != NULL && (closeMark == NULL || openMark < closeMark)) {
    relayWrite(true);
  } else if (closeMark != NULL) {
    relayWrite(false);
  } else {
    return;   // unknown cmd value — ignore silently
  }
  emitJson(false);   // ack with the new relay state
}

void setup() {
  pinMode(PIN_RELAY, OUTPUT);
  relayWrite(false);   // fail-safe default: gate closed
  Serial.begin(9600);
}

void loop() {
  const unsigned long now = millis();

  while (Serial.available() > 0) {
    const char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      cmdBuf[cmdLen] = '\0';
      if (cmdLen > 0) {
        handleCommand(cmdBuf);
        cmdLen = 0;
      }
      continue;
    }
    if (cmdLen < CMD_BUF_SIZE - 1) {
      cmdBuf[cmdLen++] = c;
    } else {
      cmdLen = 0;   // overflow — drop the buffer, resync on next newline
    }
  }

  if (now - lastHeartbeatMs >= HEARTBEAT_MS) {
    lastHeartbeatMs = now;
    emitJson(true);
  }
}
`;

const SELF_TEST_SOURCE = String.raw`// ============================================================================
// AttendX Board Self-Test — flashing + terminal validation in 60 seconds
// ============================================================================
// Target  : Arduino Uno / Nano (ATmega328P) @ 16 MHz
// Compile : arduino-cli compile --fqbn arduino:avr:uno
//
// No sensors, no wiring — the point is to prove the whole pipeline:
//   1. the Studio flashes this hex over STK500v1, and
//   2. the Control Terminal talks to the running sketch.
// The LED breathes at 1 Hz and the sketch answers serial commands (9600 8N1):
//   PING              -> ATX1,{"type":"ack","pong":1,"ts":..}
//   LED ON|OFF        -> ATX1,{"type":"ack","led":0|1,"ts":..}
//   ECHO <text>       -> ATX1,{"type":"ack","echo":"<text>","ts":..}
//   anything else     -> ATX1,{"type":"error","error":"unknown cmd","ts":..}
// ============================================================================

#include <Arduino.h>

const unsigned long BLINK_INTERVAL_MS = 500;
const uint8_t CMD_BUF_SIZE = 64;

char          cmdBuf[CMD_BUF_SIZE];
uint8_t       cmdLen          = 0;
bool          ledState        = false;
unsigned long lastBlinkMs     = 0;

void printAck(const __FlashStringHelper* key, const char* value) {
  Serial.print(F("ATX1,{\"type\":\"ack\",\""));
  Serial.print(key);
  Serial.print(F("\":\""));
  Serial.print(value);
  Serial.print(F("\",\"ts\":"));
  Serial.print(millis());
  Serial.println(F("}"));
}

void handleCommand(char* line) {
  char* tok = strtok(line, " ");
  if (tok == NULL) return;
  if (strcasecmp(tok, "PING") == 0) {
    printAck(F("pong"), "1");
  } else if (strcasecmp(tok, "LED") == 0) {
    char* arg = strtok(NULL, " ");
    ledState = (arg != NULL && strcasecmp(arg, "ON") == 0);
    digitalWrite(LED_BUILTIN, ledState ? HIGH : LOW);
    lastBlinkMs = millis();   // pause the breathe while overridden
    printAck(F("led"), ledState ? "1" : "0");
  } else if (strcasecmp(tok, "ECHO") == 0) {
    const char* rest = tok + strlen(tok) + 1;
    printAck(F("echo"), rest[0] == '\0' ? "" : rest);
  } else {
    Serial.print(F("ATX1,{\"type\":\"error\",\"error\":\"unknown cmd\",\"ts\":"));
    Serial.print(millis());
    Serial.println(F("}"));
  }
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  const unsigned long now = millis();

  while (Serial.available() > 0) {
    const char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      cmdBuf[cmdLen] = '\0';
      if (cmdLen > 0) {
        handleCommand(cmdBuf);
        cmdLen = 0;
      }
      continue;
    }
    if (cmdLen < CMD_BUF_SIZE - 1) {
      cmdBuf[cmdLen++] = c;
    } else {
      cmdLen = 0;
    }
  }

  if (now - lastBlinkMs >= BLINK_INTERVAL_MS) {
    lastBlinkMs = now;
    ledState = !ledState;
    digitalWrite(LED_BUILTIN, ledState ? HIGH : LOW);
  }
}
`;

export const SKETCHES: GateSketch[] = [
  {
    id: "gate-geofence",
    name: "AttendX Gate Geofence Controller",
    description:
      "The full gate controller: HC-SR04 ultrasonic person counting (TRIG D7 / ECHO D8), TSOP31238 IR beam on D2 with interrupt decode and 400 ms debounce, piezo buzzer on D5, non-blocking millis() loop. Emits ATX1 ultrasonic + ir_beam event lines the studio ingests into /api/gate/sensor-events, and answers terminal commands (PING / STATUS / DIST / BEEP / LED / THRESH / COUNT RESET).",
    filename: "gate-geofence.ino",
    source: GATE_GEOFENCE_SOURCE,
    commands: [
      { cmd: "PING", label: "PING", hint: "Liveness check — the board answers an ATX1 ack" },
      { cmd: "STATUS", label: "STATUS", hint: "Distance, person count, threshold — also feeds the plotter" },
      { cmd: "DIST", label: "DIST", hint: "One immediate HC-SR04 reading" },
      { cmd: "BEEP 120", label: "BEEP", hint: "Buzzer blip (optional ms arg, max 2000)" },
      { cmd: "LED ON", label: "LED ON", hint: "Light the D13 status LED" },
      { cmd: "LED OFF", label: "LED OFF", hint: "Extinguish D13" },
      { cmd: "THRESH 120", label: "THRESH 120", hint: "Set the beam-crossing threshold in cm (5–400)" },
      { cmd: "COUNT RESET", label: "COUNT RESET", hint: "Zero the person counter" },
    ],
  },
  {
    id: "self-test",
    name: "Board Self-Test",
    description:
      "Zero wiring: blinks D13 at 1 Hz and answers PING / LED ON|OFF / ECHO over serial. Flash it first to prove the STK500v1 uploader and the Control Terminal end-to-end before touching real gate hardware.",
    filename: "board-self-test.ino",
    source: SELF_TEST_SOURCE,
    commands: [
      { cmd: "PING", label: "PING", hint: "Liveness check — ack with the board uptime" },
      { cmd: "LED ON", label: "LED ON", hint: "Force the D13 LED on (pauses the breathe)" },
      { cmd: "LED OFF", label: "LED OFF", hint: "Force the D13 LED off" },
      { cmd: "ECHO hello gate", label: "ECHO hello", hint: "Round-trip an arbitrary string back through ATX1 ack" },
    ],
  },
  {
    id: "ir-node",
    name: "IR Receiver Node",
    description:
      "Standalone NEC infrared decoder: TSOP31238 on D2 (INT0), prints ATX1 ir_beam lines with the decoded remote code, confirmation beep on D5. Point any NEC remote at it to fake a beam break.",
    filename: "ir-receiver-node.ino",
    source: IR_NODE_SOURCE,
    commands: [
      { cmd: "PING", label: "PING", hint: "Only meaningful if you add the handler — this sketch is receive-only" },
    ],
  },
  {
    id: "failsafe-relay",
    name: "Gate Failsafe Relay",
    description:
      'Gate actuator failsafe: relay on D12 driven by serial JSON {"cmd":"open"|"close"} with a SoftwareSerial-safe bounded parser and a 5 s ATX1 heartbeat carrying the relay state. Power-on default is closed.',
    filename: "gate-failsafe-relay.ino",
    source: FAILSAFE_RELAY_SOURCE,
    commands: [
      { cmd: '{"cmd":"open"}', label: "OPEN GATE", hint: "Energize the relay — the gate opens" },
      { cmd: '{"cmd":"close"}', label: "CLOSE GATE", hint: "De-energize the relay — the gate closes" },
    ],
  },
];

export const sketchById = (id: string): GateSketch | undefined => SKETCHES.find((s) => s.id === id);
