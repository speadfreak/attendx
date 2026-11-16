/**
 * AttendX Gate Controller Studio — three compilable Arduino sketches (Uno,
 * 9600 8N1) for the Phase 7 gate hardware. Each source carries its wiring
 * table and the exact arduino-cli compile line. The browser cannot compile
 * AVR C — the studio flashes the .hex that `arduino-cli` produces.
 */

export interface GateSketch {
  id: string;
  name: string;
  description: string;
  /** Suggested .ino basename when downloading from the studio. */
  filename: string;
  source: string;
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
    const bool present = (cm != 0xFFFF && cm <= PERSON_DISTANCE_CM);
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

export const SKETCHES: GateSketch[] = [
  {
    id: "gate-geofence",
    name: "AttendX Gate Geofence Controller",
    description:
      "The full gate controller: HC-SR04 ultrasonic person counting (TRIG D7 / ECHO D8), TSOP31238 IR beam on D2 with interrupt decode and 400 ms debounce, piezo buzzer on D5, non-blocking millis() loop. Emits ATX1 ultrasonic + ir_beam event lines the studio ingests into /api/gate/sensor-events.",
    filename: "gate-geofence.ino",
    source: GATE_GEOFENCE_SOURCE,
  },
  {
    id: "ir-node",
    name: "IR Receiver Node",
    description:
      "Standalone NEC infrared decoder: TSOP31238 on D2 (INT0), prints ATX1 ir_beam lines with the decoded remote code, confirmation beep on D5. Point any NEC remote at it to fake a beam break.",
    filename: "ir-receiver-node.ino",
    source: IR_NODE_SOURCE,
  },
  {
    id: "failsafe-relay",
    name: "Gate Failsafe Relay",
    description:
      "Gate actuator failsafe: relay on D12 driven by serial JSON {\"cmd\":\"open\"|\"close\"} with a SoftwareSerial-safe bounded parser and a 5 s ATX1 heartbeat carrying the relay state. Power-on default is closed.",
    filename: "gate-failsafe-relay.ino",
    source: FAILSAFE_RELAY_SOURCE,
  },
];

export const sketchById = (id: string): GateSketch | undefined => SKETCHES.find((s) => s.id === id);
