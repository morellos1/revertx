import { mirrorSwitches, reportNative } from "../core/native";
import { initLikesTab } from "./likes-tab";
import { initShareMenu } from "./share-menu";

// Top frame only.
if (window.top === window) {
  mirrorSwitches();
  reportNative();
  initShareMenu();
  initLikesTab();
}
