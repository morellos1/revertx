import { mirrorSwitches, reportNative } from "../core/native";
import { initLikesTab } from "./likes-tab";
import { initMosaic } from "./mosaic";
import { initShareMenu } from "./share-menu";

// Top frame only.
if (window.top === window) {
  mirrorSwitches();
  reportNative();
  initShareMenu();
  initLikesTab();
  initMosaic();
}
