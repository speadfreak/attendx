#include <DHT.h>

const uint8_t DHT_PIN = 2;
const uint8_t RELAY_PIN = 8;
const uint8_t DHT_TYPE = DHT22;
const bool RELAY_ACTIVE_LOW = true;
const float FAN_ON_C = 30.0;
const float FAN_OFF_C = 27.0;
const unsigned long SAMPLE_INTERVAL_MS = 2000;

DHT dht(DHT_PIN, DHT_TYPE);
String fanMode = "AUTO";
bool fanOn = false;
unsigned long lastSampleAt = 0;

void setFan(bool on) {
  fanOn = on;
  digitalWrite(RELAY_PIN, (on == RELAY_ACTIVE_LOW) ? LOW : HIGH);
}

void reportStatus() {
  float tempC = dht.readTemperature();
  if (isnan(tempC)) {
    // Sensor failure defaults to cooling rather than leaving the fan off.
    setFan(true);
    Serial.println("{\"tempC\":null,\"fanState\":\"on\",\"mode\":\"sensor-error\"}");
    return;
  }
  Serial.print("{\"tempC\":");
  Serial.print(tempC, 1);
  Serial.print(",\"fanState\":\"");
  Serial.print(fanOn ? "on" : "off");
  Serial.print("\",\"mode\":\"");
  Serial.print(fanMode);
  Serial.println("\"}");
}

void applyMode(const String& requested) {
  if (requested == "ON") {
    fanMode = "ON";
    setFan(true);
  } else if (requested == "OFF") {
    fanMode = "OFF";
    setFan(false);
  } else if (requested == "AUTO") {
    fanMode = "AUTO";
  }
  reportStatus();
}

void setup() {
  pinMode(RELAY_PIN, OUTPUT);
  setFan(false);
  Serial.begin(9600);
  dht.begin();
}

void loop() {
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();
    command.toUpperCase();
    if (command == "STATUS") {
      reportStatus();
    } else if (command.startsWith("MODE ")) {
      applyMode(command.substring(5));
    }
  }

  unsigned long now = millis();
  if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = now;
    float tempC = dht.readTemperature();
    if (isnan(tempC)) {
      setFan(true);
    } else if (fanMode == "AUTO") {
      if (tempC >= FAN_ON_C) setFan(true);
      if (tempC <= FAN_OFF_C) setFan(false);
    }
  }
}
