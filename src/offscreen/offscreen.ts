interface BatteryManagerLike extends EventTarget {
  charging: boolean;
  level: number;
  dischargingTime: number;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManagerLike>;
}

interface BatteryBridgeRequest {
  target: "coppice-offscreen";
  action: "getBatteryStatus";
}

function isBatteryBridgeRequest(message: unknown): message is BatteryBridgeRequest {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<BatteryBridgeRequest>;
  return candidate.target === "coppice-offscreen" && candidate.action === "getBatteryStatus";
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isBatteryBridgeRequest(message)) return false;

  const batteryNavigator = navigator as NavigatorWithBattery;
  if (typeof batteryNavigator.getBattery !== "function") {
    sendResponse({ supported: false, reason: "Battery Status API is unavailable." });
    return false;
  }

  void batteryNavigator
    .getBattery()
    .then(battery => {
      sendResponse({
        supported: true,
        charging: battery.charging,
        level: battery.level,
        dischargingTime: Number.isFinite(battery.dischargingTime) ? battery.dischargingTime : null
      });
    })
    .catch(error => {
      sendResponse({
        supported: false,
        reason: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});
