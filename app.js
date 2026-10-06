/**
 * CT Delivery App — frontend logic (Hours 3-6 of the 8-hour build plan)
 *
 * Screens: login -> route list -> stop detail -> exceptions -> signature -> (back to route list)
 * Data: the day's route plan (route/stops/line items/totals) is fetched live from the Apps
 *       Script backend — NOT a static file bundled with this page. That's a deliberate change
 *       from the original design: publishing a new day used to mean uploading a new manifest
 *       file to GitHub every single day, which is exactly what this was changed to avoid.
 *       Office runs the Sheet menu's "Create Route Plan..." (one step — builds AND publishes)
 *       and the app picks it up on the driver's next login — no GitHub involved.
 *       As of 2026-09-24 this is a TWO-PHASE fetch, not one: init() first fetches
 *       "?action=get_trucks" (small — just today's truck list) and paints the login screen
 *       from that, then fetches the full "?action=get_route_plan" (every stop, every line
 *       item — the bigger response) in the background via loadFullRoutePlan_. See init()'s
 *       own comment for the full rationale and Code.gs's getTrucksForRequest_ /
 *       getRoutePlanForRequest_ / publishRoutePlan_ and PROJECT-NOTES.md.
 *       This fetched data still lives in a JS variable/property named "manifest" throughout
 *       this file below (kept as-is on purpose when the backend was renamed to "route plan" —
 *       purely internal, not worth the diff/regression risk of renaming everywhere for no
 *       user-visible benefit — see PROJECT-NOTES.md).
 *       pins.json (truck PINs) is still a plain static file — those essentially never change.
 *       As of 2026-09-29, the initial fetch is no longer the only one for a given login —
 *       see the LIVE ROUTE-PLAN REFRESH section below for a periodic background re-fetch that
 *       keeps truck/time/rack/address data current through a shift as dispatch changes it in
 *       ERP-outFuture, without needing a re-login. Line items stay whatever the last "Create
 *       Route Plan..." run published (deliberately NOT re-fetched on this same timer — see
 *       that section's comment for why). stopKey_ (customer_code), not stop_id, is now the
 *       stable per-stop identity everywhere LOCAL DRIVER-STATE PERSISTENCE cares about one,
 *       since stop_id itself can change on a live refresh (a truck/time reassignment) — see
 *       stopKey_'s own comment.
 *       As of 2026-09-30, BOTH phase 1 and phase 2 above are pure static file reads — the
 *       live ERP-outFuture rebuild (previously done inline on every get_trucks/get_route_plan
 *       call, which made the app's core load path depend on a live Sheets round trip) moved
 *       entirely into the LIVE ROUTE-PLAN REFRESH mechanism: it fires once in the background
 *       right after the initial load, then on its usual timer — never gating what the driver
 *       sees. Per G's "it should not be pulled fresh on every request! the app still should
 *       work offline - this should be more of a thing if there is good connection etc it
 *       reads the live data again but without slowing the app down." See
 *       getRoutePlanForRequest_'s "PURE STATIC AGAIN" comment in Code.gs for the full history.
 *
 * Offline-first: two separate layers, both needed.
 *   1. service-worker.js caches the app SHELL (this file, style.css, index.html,
 *      pins.json) so the page itself still loads with zero signal — even a cold
 *      relaunch, not just staying on an already-open tab. Registered below.
 *   2. The route plan DATA (this changes daily, so it's never put in the
 *      service worker's shell cache) is cached in localStorage after every
 *      successful fetch and re-used if a later fetch fails — see init() below.
 *      This means: load the app once with signal (e.g. at the depot in the
 *      morning), and it keeps working the rest of the day even through dead
 *      zones or a device restart, showing whatever route plan was last
 *      successfully fetched with a clear "offline" notice.
 *
 * ====================================================================
 * SETUP STEP YOU STILL NEED TO DO: paste your Apps Script /exec URL
 * below (from Extensions > Apps Script > Deploy > Web app, after
 * pasting in Code.gs). Until this is a real URL, submits will fail
 * and queue offline (which is safe, but nothing reaches the Sheet) —
 * and the manifest fetch below will fail too, since it uses this same URL.
 * ====================================================================
 */
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbydrIdUUOPO617n9eaXuiKYKjbfK4GaeAezsWVF9JQSMjARFiEyrVXFQlQMAfnrQcmn_Q/exec";

const PINS_FILE = "pins.json";
const STORAGE_KEY_STATE = "ct_driver_state_v1";
const STORAGE_KEY_QUEUE = "ct_offline_queue_v1";
const STORAGE_KEY_ROUTE_PLAN_CACHE = "ct_route_plan_cache_v1"; // last successfully fetched {manifest, pins}, for offline fallback
const STORAGE_KEY_ROUTE_TIMING_STATE = "ct_route_timing_state_v1"; // routeStarted_/routeEnded_ + their timestamps, keyed to today's truck+date — see restoreRouteTimingStateLocal_
const STORAGE_KEY_ITEMS_CATALOG_CACHE = "ct_items_catalog_cache_v1"; // last successfully fetched items catalog (see loadItemsCatalog_), for offline "Add Item" search after the first load

// Native-storage keys for the iOS app's background sync (see NATIVE
// BACKGROUND SYNC, near the OFFLINE QUEUE section below) — these are NOT
// localStorage keys, they're written/read via the Capacitor Preferences
// plugin, which on iOS is backed by UserDefaults (readable from the native
// Swift background-task code that can't see this WebView's localStorage at
// all) and on plain web/PWA quietly falls back to a differently-prefixed
// localStorage key of its own, same effect either way — harmless, mostly
// inert there since nothing ever populates STORAGE_KEY_NATIVE_SYNCED
// without the native task running.
const STORAGE_KEY_NATIVE_QUEUE_MIRROR = "ct_native_offline_queue_v1"; // mirror of STORAGE_KEY_QUEUE, written every time the queue changes
const STORAGE_KEY_NATIVE_SYNCED = "ct_native_synced_ids_v1"; // native background task writes [{_queue_id, stop_id, pdf_file_id}] here after a successful background send; reconcileNativeBackgroundSyncs_ reads + clears it
const STORAGE_KEY_NATIVE_APPS_SCRIPT_URL = "ct_apps_script_url"; // APPS_SCRIPT_URL mirrored once at startup, since native Swift code can't read this file's own JS constant directly

// ---------- app state ----------
let manifest = null;
let pins = null;
let manifestReadyPromise_ = null; // set once in init() to loadFullRoutePlan_()'s promise; the login button handler awaits this if the driver taps "Start Route" before the full route plan has finished loading in the background — see both places below
let selectedTruck = null;   // truck chosen on login screen, before PIN is confirmed
let currentTruck = null;    // truck the driver is logged into
let truckDriverNames_ = {}; // {"Truck 4": "Jeremy"} — from the same get_trucks payload as the login screen's truck buttons; kept around for the route screen's greeting
let truckStartTimes_ = {};  // {"Truck 4": "6:00 AM"} — same deal; this is the ERP's CLOCK-IN time, not a leave time — see plannedLeaveTimeStr_ for the +30-minute adjustment applied before it's ever shown or logged
let routeStarted_ = false;  // true once "Start Driving" has actually logged a Route Start row this login — reset on each fresh login (see wireLoginScreen). Kept idempotent so re-rendering the route screen never double-logs a start.
let routeEnded_ = false;    // true once "End Route" has actually logged a Route End row this login — reset on each fresh login, same as routeStarted_. See endRoute_.
let routeStartedAtLocal_ = null; // Date the driver tapped Start Driving, this login — for the on-screen "Route started at ..." line only (the actual logged timestamp lives on the backend). See startRoute_/updateRouteStatusBox_.
let routeEndedAtLocal_ = null;   // same, for End Route.
let currentStop = null;     // the stop object currently open in stop/exceptions/signature screens
let flaggedItems = {};      // idx -> {item_code, item_name, size, qty, reason, qty_change, notes}
let countedItems = {};      // idx -> true, when Count Items mode has this row checked off (see renderItemPickList_)
let countModeActive = false; // whether the Count Items per-row checkboxes are currently shown
let itemSearchText_ = "";   // current text in the item search box (see #item-search-input)
// {"2in": true, ...} — sizes (plus the OTHER_SIZE_FILTER_KEY_ sentinel for
// "Everything Else") currently toggled on as quick filters, OR'd together.
// One shared state now (2026-09-29, per G's "only keep the top filter
// buttons - just filters both areas") — it drives BOTH the stop's own item
// pick list (renderItemPickList_) AND the add-item catalog search
// (renderAddItemResults_), via the one button row rendered by
// renderSizeFilterButtons_. There used to be a second, separate button row
// (and a separate activeAddItemSizeFilters_ state) just for the add-item
// catalog search — removed outright, not just hidden, since G's screenshot
// showed two near-identical rows and asked to keep only the top one.
let activeSizeFilters_ = {};
// "Add Item" state — per G's "add the option to add items on the view."
// See the ADD ITEM section further down for the functions that read/write
// these. addedItems is keyed by a locally-assigned id (these items have no
// original line-item index the way flaggedItems' keys do), each value
// {item_code, item_name, common_name, size, qty, unit_price, notes}.
let addedItems = {};
let addedItemIdCounter_ = 0;
let addItemPanelOpen_ = false;   // whether #add-item-panel is currently shown — preserved on a same-stop back-and-forth, like countModeActive
let addItemSearchText_ = "";     // current text in #add-item-search-input
let itemsCatalog_ = null;        // the full ERP items catalog, once fetched — see loadItemsCatalog_. Deliberately module-level (not per-stop): once loaded it's reused for every stop the rest of the shift, not re-fetched each time this panel is opened.
let itemsCatalogLoadPromise_ = null; // the in-flight fetch, if any — so opening the panel twice quickly doesn't fire two requests
let sigPad = { ctx: null, drawing: false, hasStroke: false };
let rackPhotoDataUrl = null; // compressed JPEG data URL of the driver's rack photo for the current stop, or null

// ---------- boot ----------
document.addEventListener("DOMContentLoaded", init);

async function init() {
  registerServiceWorker_();
  // No-op on plain web/PWA — see the two functions' own comments (NATIVE
  // BACKGROUND SYNC section). On the native iOS app, this is what lets the
  // Swift background-sync task find the current backend URL and pick up
  // anything it managed to send while the app was fully closed.
  mirrorAppsScriptUrlToNative_();
  reconcileNativeBackgroundSyncs_();

  wireLoginScreen();
  wireRouteScreen();
  wireStopScreen();
  wireSignatureScreen();
  wirePhotoCapture();
  setupSignaturePad();

  // Two-phase load. This REPLACES an earlier stale-while-revalidate design
  // that painted a CACHED truck list immediately and silently swapped in
  // fresh data later — G flagged that as actively wrong, not just slow
  // ("trucks change... just the trucks that run that day load first and
  // entire data loads after"). Both phases below are, as of 2026-09-30,
  // plain fast file reads — NEITHER does a live ERP-outFuture rebuild
  // inline anymore (see the LIVE ROUTE-PLAN REFRESH kick a few lines down
  // for where that moved) — so the two-phase split here is purely about
  // response SIZE (today's trucks list vs. every stop's full line items),
  // not about one phase being slow:
  //   1. get_trucks (loadFullRoutePlan_'s sibling, inline below) — a tiny
  //      file with just {dispatch_date, trucks, truck_drivers,
  //      truck_start_times}, written by publishRoutePlan_ alongside the
  //      full route plan (see Code.gs).
  //   2. get_route_plan — the FULL route plan (every stop, every line
  //      item) — a bigger file, not a slower one. loadFullRoutePlan_ runs
  //      this in the background, in parallel with phase 1, and the login
  //      button handler (wireLoginScreen, below) awaits
  //      manifestReadyPromise_ if the driver enters a valid PIN before
  //      phase 2 has finished.
  // The offline route-plan cache (localStorage) still exists as a fallback
  // for both phases if the corresponding fetch can't be reached at all
  // (shown with a clear "offline"/stale-data toast, never silently), so
  // the app still works through a dead zone after loading once this
  // morning with signal.
  const cachedPlan = loadRoutePlanCache_();

  manifestReadyPromise_ = loadFullRoutePlan_(cachedPlan);
  // As soon as the fast static load above settles (success OR falling back
  // to cache — refreshRoutePlanLive_ itself no-ops if manifest never ended
  // up set at all), kick ONE live ERP-outFuture check in the background —
  // per G's "if there is good connection etc it reads the live data again
  // but without slowing the app down": this is what actually applies any
  // live truck/time/rack correction, but it happens AFTER the driver
  // already has a usable screen, never before, and a slow/failed check
  // here never blocks or delays anything (see refreshRoutePlanLive_'s own
  // silent-on-failure handling). The existing periodic timer below then
  // keeps checking every 5 minutes for the rest of the shift.
  manifestReadyPromise_.then(() => refreshRoutePlanLive_());

  // Also start warming the items catalog (used by "+ Add Item" on the stop
  // screen) right away, in the background, alongside the route plan fetch —
  // per G's "item catalog needs to work offline and should not take any
  // time to load." This used to only start the first time a driver actually
  // opened the Add Item panel, which meant a real, visible "Loading item
  // catalog…" wait mid-delivery, and nothing cached yet if signal dropped
  // before that first tap. Starting it here means it's almost always already
  // warm (freshly fetched, or filled in from localStorage — see
  // loadItemsCatalog_) well before a driver reaches any stop, so opening the
  // panel later is instant. Fire-and-forget — nothing here awaits it or
  // blocks login on it finishing.
  loadItemsCatalog_();

  let trucksCacheReason = null; // null | "offline" | "not_published" — same meaning/messaging as before, just now scoped to the trucks fetch instead of the whole route plan
  let trucksData = null;
  try {
    const [trucksRes, pinsRes] = await Promise.all([
      fetch(APPS_SCRIPT_URL + "?action=get_trucks", { cache: "no-store" }),
      fetch(PINS_FILE, { cache: "no-store" }),
    ]);
    const trucksJson = await trucksRes.json();
    if (trucksJson && trucksJson.ok === false) {
      if (!cachedPlan) {
        showToast(trucksJson.error || "No route plan published yet.");
        console.error("trucks fetch returned an error", trucksJson);
        return;
      }
      console.error("trucks fetch returned an error; falling back to the last cached truck list", trucksJson);
      trucksData = cachedPlan.manifest;
      trucksCacheReason = "not_published";
    } else {
      trucksData = trucksJson;
    }
    pins = await pinsRes.json();
  } catch (err) {
    // Network-level failure (offline, dead zone, etc.) — fall back to the
    // last cached truck list instead of leaving the login screen blank.
    // Still clearly labeled as possibly-stale below, since this is exactly
    // the case ("trucks change") the two-phase design exists to avoid
    // showing silently.
    if (!cachedPlan) {
      showToast("Could not load today's trucks. Check your connection and reload.");
      console.error("trucks/pins load failed, and no offline cache available", err);
      return;
    }
    console.warn("trucks fetch failed; falling back to the last cached truck list", err);
    trucksData = cachedPlan.manifest;
    pins = cachedPlan.pins;
    trucksCacheReason = "offline";
  }

  document.getElementById("login-date").textContent = formatDispatchDate_(trucksData.dispatch_date);
  renderTruckSelect_(trucksData.trucks || [], trucksData.truck_drivers || {});
  // Kept around (not just used inline above) for the route screen's status
  // card, which needs the same driver-name/start-time lookups after login.
  truckDriverNames_ = trucksData.truck_drivers || {};
  truckStartTimes_ = trucksData.truck_start_times || {};
  if (trucksCacheReason === "offline") {
    showToast("Offline — showing the last truck list loaded (" + formatDispatchDate_(trucksData.dispatch_date) + "). Trucks running today may have changed.");
  } else if (trucksCacheReason === "not_published") {
    showToast("No newer route plan published yet — showing the last truck list loaded (" + formatDispatchDate_(trucksData.dispatch_date) + ").");
  }

  updateQueueBanner_();
  window.addEventListener("online", () => flushOfflineQueue_());
  // The browser's "online" event only fires on an actual offline->online
  // transition. It does NOT fire just because a submit happened to time out
  // while the device was on wifi the whole time (a slow Apps Script cold
  // start, say — see the timeout comment in sendToBackend_) — that item
  // would then sit queued, with the banner saying "will send automatically
  // when back online," indefinitely, on a connection that was never
  // actually lost. Two more triggers close that gap: a periodic retry
  // while anything's queued, and one whenever the driver brings the app
  // back into view (switching back from another app, waking the screen) —
  // a natural moment real connectivity is most likely present, and it
  // doesn't depend on the browser's own (notoriously unreliable on iOS
  // Safari) online/offline detection at all.
  setInterval(() => { if (readQueue_().length > 0) flushOfflineQueue_(); }, 30000);
  // LIVE ROUTE-PLAN REFRESH — see that section's own comment for the full
  // design. Same periodic-timer + visibilitychange pattern as the offline
  // queue flush right above (the incoming-data mirror of that outgoing one).
  setInterval(() => refreshRoutePlanLive_(), ROUTE_PLAN_LIVE_REFRESH_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    // Same "coming back into view is the natural moment to check" reasoning
    // as flushOfflineQueue_ below — also the natural moment to pick up
    // anything the native background-sync task sent while this page wasn't
    // running at all (see reconcileNativeBackgroundSyncs_'s own comment),
    // and to pick up any truck/time/rack change dispatch made while this
    // page wasn't open rather than waiting for the next timer tick.
    reconcileNativeBackgroundSyncs_();
    if (readQueue_().length > 0) flushOfflineQueue_();
    refreshRoutePlanLive_();
  });
  // also try once on load in case there's a leftover queue from a prior offline session
  flushOfflineQueue_();
}

// Phase 2 of init()'s two-phase load: fetches the FULL route plan (every
// stop, every line item — the genuinely slow Drive/Sheets round trip) in
// the background, in parallel with phase 1's fast get_trucks fetch above.
// Sets the module-level `manifest`/`pins` on success and caches them for
// offline use next time, exactly like the old single-phase load did.
// Returns true once manifest/pins are usable (either freshly fetched or
// filled in from the offline cache) or false if nothing could be loaded at
// all — the login button handler (wireLoginScreen, below) awaits this via
// manifestReadyPromise_ and checks that return value if the driver taps
// "Start Route" before this has finished.
async function loadFullRoutePlan_(cachedPlan) {
  try {
    const [manifestRes, pinsRes] = await Promise.all([
      fetch(APPS_SCRIPT_URL + "?action=get_route_plan", { cache: "no-store" }),
      fetch(PINS_FILE, { cache: "no-store" }),
    ]);
    const manifestJson = await manifestRes.json();
    // NOTE: as of 2026-09-24 the backend serves whatever route plan is
    // currently published, whatever date it's for — it no longer checks
    // that against today (see the TODO comment on getRoutePlanForRequest_
    // in Code.gs for why, and why that check should come back before this
    // is relied on for real daily driving).
    if (manifestJson && manifestJson.ok === false) {
      if (!cachedPlan) {
        console.error("route plan fetch returned an error, and no offline cache available", manifestJson);
        return false;
      }
      console.error("route plan fetch returned an error; falling back to the last cached route plan", manifestJson);
      manifest = cachedPlan.manifest;
      pins = cachedPlan.pins;
      applyStoredDriverState_();
      return true;
    }
    manifest = manifestJson;
    pins = await pinsRes.json();
    saveRoutePlanCache_(manifest, pins);
    applyStoredDriverState_();
    return true;
  } catch (err) {
    // Network-level failure (offline, dead zone, etc.) — fall back to the
    // last successfully loaded route plan/pins, same offline-first
    // behavior as before, just now scoped to phase 2 only.
    if (!cachedPlan) {
      console.error("route plan fetch failed, and no offline cache available", err);
      return false;
    }
    console.warn("background route plan load failed; falling back to the last cached route plan", err);
    manifest = cachedPlan.manifest;
    pins = cachedPlan.pins;
    applyStoredDriverState_();
    return true;
  }
}

// ==================================================================
// LOGIN SCREEN
// ==================================================================
// Truck buttons are NOT hardcoded. renderTruckSelect_(trucks, truckDrivers)
// (called from init() once the fast get_trucks fetch resolves — see the
// two-phase load comment in init()) builds one button per truck that
// actually has stops in TODAY's published route plan. This is deliberate,
// not an oversight: a fixed "Truck 4 / Truck 5" list silently left out any
// other truck ERP-outFuture had assigned stops to — found for real when
// Truck 3 had a full route and wasn't selectable at all. A truck still
// needs an entry in pins.json to actually log in (that file is unrelated
// to which buttons render — see its own comment); a truck that shows up
// in today's route but has no pins.json entry yet gets its own clear
// error at login time below, rather than "Wrong PIN."
//
// truckDrivers (e.g. {"Truck 4": "Jeremy"}) comes from the same
// get_trucks/route-plan payload as `trucks` — set server-side in
// publishRoutePlan_ from each stop's driver_name column, so it's already
// there for free. Shown as a small second line under the truck name (per
// G's request) so a driver can visually confirm "yes, that's my truck"
// against a name, not just a number — several trucks look alike and
// numbers alone have been mis-tapped before.
function renderTruckSelect_(trucksIn, truckDrivers) {
  const truckSelect = document.getElementById("truck-select");
  truckSelect.innerHTML = "";

  const trucks = (trucksIn || []).slice().sort((a, b) => {
    const na = parseInt((a.match(/\d+/) || ["0"])[0], 10);
    const nb = parseInt((b.match(/\d+/) || ["0"])[0], 10);
    return na - nb;
  });

  if (trucks.length === 0) {
    truckSelect.innerHTML = '<p class="hint">No trucks have stops in today’s route plan.</p>';
    return;
  }

  trucks.forEach((truck) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-truck", truck);

    const nameSpan = document.createElement("span");
    nameSpan.className = "truck-name";
    nameSpan.textContent = truck;
    btn.appendChild(nameSpan);

    const driverName = truckDrivers && truckDrivers[truck];
    if (driverName) {
      const driverSpan = document.createElement("span");
      driverSpan.className = "truck-driver";
      driverSpan.textContent = driverName;
      btn.appendChild(driverSpan);
    }

    btn.addEventListener("click", () => {
      truckSelect.querySelectorAll("button").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedTruck = truck;
      document.getElementById("login-error").textContent = "";
      updateLoginBtnState_();
    });
    truckSelect.appendChild(btn);
  });
}

function updateLoginBtnState_() {
  const pinInput = document.getElementById("pin-input");
  const loginBtn = document.getElementById("login-btn");
  loginBtn.disabled = !(selectedTruck && pinInput.value.trim().length >= 4);
}

function wireLoginScreen() {
  const pinInput = document.getElementById("pin-input");
  const loginBtn = document.getElementById("login-btn");
  const loginError = document.getElementById("login-error");

  pinInput.addEventListener("input", () => {
    // digits only
    pinInput.value = pinInput.value.replace(/\D/g, "").slice(0, 4);
    loginError.textContent = "";
    updateLoginBtnState_();
  });

  loginBtn.addEventListener("click", async () => {
    const enteredPin = pinInput.value.trim();
    if (!selectedTruck || !enteredPin) return;

    if (!pins) {
      // pins never loaded — either today's route plan hasn't been published yet
      // (see init()'s trucks fetch, which returns early before loading pins in
      // that case) or the pins.json fetch itself failed. Either way,
      // no PIN could ever match here, so saying "Wrong PIN" would be misleading —
      // the actual fix is publishing today's route plan or reloading the page.
      loginError.textContent = "Route data hasn't loaded — check that today's Route Plan has been published, then reload this page.";
      return;
    }

    const realPin = pins[selectedTruck];
    if (!realPin) {
      // Truck showed up as a button (it has real stops today) but pins.json
      // doesn't know about it yet — different problem than a wrong PIN, so
      // it gets its own message per the same rule as the block above.
      loginError.textContent = selectedTruck + " doesn't have a PIN set up yet — add one to pins.json.";
      return;
    }
    if (enteredPin !== realPin) {
      loginError.textContent = "Wrong PIN for " + selectedTruck + ". Try again.";
      pinInput.value = "";
      updateLoginBtnState_();
      return;
    }

    // PIN's correct. The truck list (phase 1) is loaded by now, but the
    // FULL route plan (phase 2 — every stop's details, needed by
    // renderRouteList_/openRouteScreen_) may still be loading in the
    // background if the driver was quick on the PIN. Wait for it here
    // rather than opening an empty route screen.
    if (!manifest) {
      const originalLabel = loginBtn.textContent;
      loginBtn.disabled = true;
      loginBtn.textContent = "Loading route details…";
      loginError.textContent = "";
      const loaded = await manifestReadyPromise_;
      loginBtn.textContent = originalLabel;
      if (!loaded || !manifest) {
        loginBtn.disabled = false;
        loginError.textContent = "Could not load today's route details. Check your connection and try again.";
        return;
      }
      updateLoginBtnState_();
    }

    currentTruck = selectedTruck;
    pinInput.value = "";
    loginError.textContent = "";
    // Restores routeStarted_/routeEnded_ from localStorage if this exact
    // truck+date already has a saved Start Driving/End Route state (a
    // driver who already started their route, then reloaded or relaunched
    // the app later the same shift, should still see "End Route" — not
    // "Start Driving" again). A genuinely new truck/day starts fresh. See
    // restoreRouteTimingStateLocal_.
    restoreRouteTimingStateLocal_();
    openRouteScreen_();
  });
}

// ==================================================================
// ROUTE SCREEN (merged "here's your day" briefing + the stop list, per G's
// "im thinking we could merge the good morning name and the stops page" —
// used to be two screens (screen-briefing you tapped through, then
// screen-route); now the greeting/stop-count/leave-time/Start-Driving card
// sits directly above the stop list on one screen. "Start Driving" stays
// its own explicit, separately-logged action either way (G's call,
// confirmed 2026-09-27) — landing here does NOT itself log a route start.
// ==================================================================
function wireRouteScreen() {
  document.getElementById("logout-btn").addEventListener("click", () => {
    currentTruck = null;
    selectedTruck = null;
    document.getElementById("truck-select").querySelectorAll("button").forEach((b) => b.classList.remove("selected"));
    document.getElementById("login-btn").disabled = true;
    showScreen_("screen-login");
  });
  // One button, three states (see updateRouteStatusBox_) — which action a
  // tap triggers is decided here from the current state rather than baked
  // into a fixed handler, since the button's job changes as the day goes
  // on: Start Driving -> End Route -> (disabled) Route Ended.
  document.getElementById("start-driving-btn").addEventListener("click", () => {
    if (!routeStarted_) {
      startRoute_();
    } else if (!routeEnded_) {
      endRoute_();
    }
    // else: already ended — button is disabled, so a click can't land here.
  });
}

function openRouteScreen_() {
  document.getElementById("route-truck-title").textContent = currentTruck;
  document.getElementById("route-date-sub").textContent = formatDispatchDate_(manifest.dispatch_date);
  updateRouteStatusBox_();
  renderRouteList_();
  showScreen_("screen-route");
}

// Fills in the greeting/stop-count/leave-time card and puts the Start
// Driving/End Route button in the right state. Called once when the route
// screen opens, and again from startRoute_/endRoute_ right after each logs
// its event — no screen navigation involved either time now that briefing
// and the stop list are the same screen.
//
// True only for the FIRST day of a multi-day "overnight" route — per G's
// "back at cascade [button] except its first day of overnight truck":
// on that one day the driver genuinely isn't heading back to the nursery
// once the day's stops are done, so the tappable end-of-route button keeps
// the generic "End Route" label instead of "Back at Cascade". Every other
// case (a normal same-day route, or a LATER day of a multi-day route)
// shows "Back at Cascade". Detected off driver_name's existing free-text
// convention from ERP-outFuture (e.g. "Kent-Overnight(1)") — there's no
// separate structured overnight/day field, this is the only signal there
// is, and G confirmed "(1)" is what marks day one specifically (later
// days — "(2)", "(3)", etc. — are NOT treated as first-day).
function isFirstOvernightDay_(driverName) {
  return !!driverName && driverName.indexOf("Overnight(1)") !== -1;
}

function updateRouteStatusBox_() {
  const driverName = truckDriverNames_[currentTruck] || currentTruck;
  document.getElementById("route-greeting").textContent = greetingForPacificTime_() + ", " + driverName + "!";

  const stopCount = manifest.stops.filter((s) => s.truck === currentTruck).length;
  document.getElementById("route-stop-count").textContent =
    "You have " + stopCount + (stopCount === 1 ? " stop" : " stops") + " today.";

  // truckStartTimes_ holds the ERP clock-in time, not the leave time — see
  // plannedLeaveTimeStr_'s own comment. Falls back to the raw clock-in value
  // if it's ever in some other shape this app hasn't seen (so the driver
  // still gets SOME time rather than the "no planned time" message when one
  // genuinely was published, just without the +30 buffer applied that once).
  const clockInTime = truckStartTimes_[currentTruck];
  const leaveTime = clockInTime ? plannedLeaveTimeStr_(clockInTime) || clockInTime : null;
  document.getElementById("route-leave-time").textContent = leaveTime
    ? "The plan is to leave at " + leaveTime + "."
    : "No planned leave time set for " + currentTruck + " today.";

  const btn = document.getElementById("start-driving-btn");
  const timingStatus = document.getElementById("route-timing-status");
  btn.classList.remove("end-route-state");
  btn.disabled = false;

  if (routeEnded_) {
    btn.textContent = "Route Ended";
    btn.disabled = true;
    timingStatus.textContent =
      "Route started at " + formatClockPacific_(routeStartedAtLocal_) +
      " · ended at " + formatClockPacific_(routeEndedAtLocal_) + ".";
    timingStatus.classList.remove("hidden");
  } else if (routeStarted_) {
    btn.textContent = isFirstOvernightDay_(driverName) ? "End Route" : "Back at Cascade";
    btn.classList.add("end-route-state");
    timingStatus.textContent = "Route started at " + formatClockPacific_(routeStartedAtLocal_) + ".";
    timingStatus.classList.remove("hidden");
  } else {
    btn.textContent = "Start Driving";
    timingStatus.textContent = "";
    timingStatus.classList.add("hidden");
  }
}

// Checked in Pacific time explicitly (business operates in Pacific), not
// whatever timezone the driver's iPad happens to be set to.
function greetingForPacificTime_() {
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(new Date()),
    10
  );
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// Same Pacific-time-explicit reasoning as greetingForPacificTime_ — used for
// the on-screen "Route started/ended at ..." line (G's "show on the app
// when driver started") so it always reads consistent with what actually
// gets logged to the Route Timing sheet, regardless of the iPad's own
// clock/timezone setting.
function formatClockPacific_(date) {
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(date);
}

// truckStartTimes_ (ERP-outFuture's "start time" column) is the driver's
// CLOCK-IN time, not their leave time — per G's feedback on the "The plan is
// to leave at 5:00am" text: "This is based on the time that I select on the
// ERP as the start time. This is NOT the time the driver leaves, but the
// time they clock in to work. I give them about 30 minutes to load their
// truck and leave, so if their start time was set to 5:00am, their leave
// time should be 5:30am." G still wants the app telling the driver an actual
// leave time ("I like that it tells the driver what time they should be
// leaving") — just the ERP's raw clock-in value plus this fixed buffer, not
// the clock-in value verbatim. Parses/reformats the same "H:MM AM/PM" shape
// Code.gs's own parseDeliveryTimeToMinutes_/formatMinutesToTimeStr_ use for
// this same string (kept duplicated here, not shared, since this is a
// frontend-only file with no import of Code.gs) — a value that isn't the
// expected 12-hour-clock shape returns null rather than guessing.
const LEAVE_TIME_BUFFER_MINUTES_ = 30;
function plannedLeaveTimeStr_(clockInTimeStr) {
  const m = String(clockInTimeStr || "").trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === "PM") hour += 12;
  const totalMinutes = (hour * 60 + parseInt(m[2], 10) + LEAVE_TIME_BUFFER_MINUTES_ + 1440) % 1440;
  const outHour24 = Math.floor(totalMinutes / 60);
  const outMinute = totalMinutes % 60;
  const ampm = outHour24 >= 12 ? "PM" : "AM";
  let displayHour = outHour24 % 12;
  if (displayHour === 0) displayHour = 12;
  return displayHour + ":" + String(outMinute).padStart(2, "0") + " " + ampm;
}

// Logs the actual route-start time to the Route Timing sheet (best-effort,
// via the same offline queue as stop submits — see OFFLINE QUEUE below).
// Doesn't wait on the network: the driver tapping "Start Driving" should
// never be blocked by a slow/dead connection, same reasoning as submitStop_.
function startRoute_() {
  if (routeStarted_) return; // idempotent — see the routeStarted_ declaration above
  routeStarted_ = true;
  routeStartedAtLocal_ = new Date();

  const driverName = truckDriverNames_[currentTruck] || currentTruck;
  const stopCount = manifest.stops.filter((s) => s.truck === currentTruck).length;
  const payload = {
    action: "start_route",
    date: manifest.dispatch_date,
    truck: currentTruck,
    driver_name: driverName,
    stop_count: stopCount,
    // Same +30-minute leave-time adjustment as the on-screen "plan is to
    // leave at" text (see plannedLeaveTimeStr_) — so the Route Timing
    // sheet's planned-vs-actual diff office sees is measured against the
    // real intended leave time, not the ERP's raw clock-in time.
    planned_leave_time: (truckStartTimes_[currentTruck] && plannedLeaveTimeStr_(truckStartTimes_[currentTruck])) || truckStartTimes_[currentTruck] || "",
    started_at_iso: routeStartedAtLocal_.toISOString(),
  };
  queueOffline_(payload);
  flushOfflineQueue_();
  saveRouteTimingStateLocal_();
  updateRouteStatusBox_();
}

// Logs the actual route-end time — G's "change button to ended route... so
// driver clicks as well when route done for the day," so the office can see
// a full start-to-end elapsed time for the day in the Route Timing sheet,
// not just individual stop times. Same idempotent/offline-safe pattern as
// startRoute_. There's no published planned end time (only a planned leave
// time), so the backend just logs the actual Pacific timestamp with no
// planned/diff comparison — see handleEndRoute_ in Code.gs.
function endRoute_() {
  if (!routeStarted_ || routeEnded_) return; // can't end a route that hasn't started, or end it twice
  routeEnded_ = true;
  routeEndedAtLocal_ = new Date();

  const driverName = truckDriverNames_[currentTruck] || currentTruck;
  const payload = {
    action: "end_route",
    date: manifest.dispatch_date,
    truck: currentTruck,
    driver_name: driverName,
    ended_at_iso: routeEndedAtLocal_.toISOString(),
  };
  queueOffline_(payload);
  flushOfflineQueue_();
  saveRouteTimingStateLocal_();
  updateRouteStatusBox_();
}

// routeStarted_/routeEnded_ (and their timestamps) used to live in memory
// only — fine as long as the page never reloaded, but a browser/PWA reload
// (including the routine "hard reload to pick up an app update" this
// project does after every delivery) drops back to the login screen, and
// logging back in used to unconditionally reset these flags to false. A
// driver who already tapped Start Driving, then reloaded or relaunched the
// app later the same shift, would see "Start Driving" again instead of "End
// Route" — tapping it then logged a SECOND Route Start row to the sheet
// instead of the route end they actually meant to log. This is why
// Route Timing showed two "Route Start" rows for the same truck+date
// instead of a Start and an End. Persisted here per truck+date (via
// manifest.dispatch_date, the same date value every Route Timing row is
// already keyed on) so it survives a reload/relaunch the same day; logging
// into a different truck, or a new day's route plan, still starts fresh.
function saveRouteTimingStateLocal_() {
  if (!manifest || !currentTruck) return;
  try {
    localStorage.setItem(STORAGE_KEY_ROUTE_TIMING_STATE, JSON.stringify({
      key: manifest.dispatch_date + "|" + currentTruck,
      routeStarted: routeStarted_,
      routeEnded: routeEnded_,
      startedAtIso: routeStartedAtLocal_ ? routeStartedAtLocal_.toISOString() : null,
      endedAtIso: routeEndedAtLocal_ ? routeEndedAtLocal_.toISOString() : null,
    }));
  } catch (err) {
    console.warn("could not persist route timing state", err);
  }
}

// Called right after a successful login, in place of the old unconditional
// reset — restores a saved Start Driving/End Route state for this exact
// truck+date if one exists (see saveRouteTimingStateLocal_ above), or
// starts fresh (all false/null) for a truck/date that's never tapped Start
// Driving yet, same as before this fix.
function restoreRouteTimingStateLocal_() {
  routeStarted_ = false;
  routeEnded_ = false;
  routeStartedAtLocal_ = null;
  routeEndedAtLocal_ = null;
  if (!manifest || !currentTruck) return;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_ROUTE_TIMING_STATE) || "null");
    if (saved && saved.key === manifest.dispatch_date + "|" + currentTruck) {
      routeStarted_ = !!saved.routeStarted;
      routeEnded_ = !!saved.routeEnded;
      routeStartedAtLocal_ = saved.startedAtIso ? new Date(saved.startedAtIso) : null;
      routeEndedAtLocal_ = saved.endedAtIso ? new Date(saved.endedAtIso) : null;
    }
  } catch (err) {
    console.warn("could not restore route timing state", err);
  }
}

function renderRouteList_() {
  const list = document.getElementById("route-list");
  list.innerHTML = "";

  const stops = manifest.stops.filter((s) => s.truck === currentTruck);
  if (stops.length === 0) {
    list.innerHTML = '<p class="hint">No stops found for ' + currentTruck + ' today.</p>';
    return;
  }

  stops.forEach((stop) => {
    const status = (stop.driver_state && stop.driver_state.status) || "pending";
    const card = document.createElement("div");
    card.className = "stop-card " + statusToClass_(status);

    const left = document.createElement("div");
    const time = document.createElement("div");
    time.className = "time";
    if (stop.delivery_time) {
      time.textContent = stop.delivery_time;
    } else {
      time.textContent = "No time set";
      time.classList.add("unset");
    }
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = stop.customer_name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.appendChild(document.createTextNode(stopMetaLine_(stop) + " · "));
    appendAddressWithBoldCity_(meta, stop.address || "");
    left.appendChild(time);
    left.appendChild(name);
    left.appendChild(meta);

    const pill = document.createElement("span");
    pill.className = "status-pill";
    pill.textContent = statusToLabel_(status);

    // Right-hand column: status pill + a "Map" action button, per G's "on
    // this view add on each of the stops an action button that opens
    // address in maps" — this view (the route list) only ever showed the
    // address as plain text inside the card, unlike the stop-detail screen,
    // which already has the address itself as a tappable maps link (see
    // mapsUrlForAddress_/the address-link rule elsewhere in this file). A
    // dedicated button here means a driver can jump straight to
    // navigation from the route list without opening the stop first. Real
    // <a target="_blank"> (same convention as that other link), not a JS
    // window.open() — works the same on Android and iOS with no user-agent
    // branching. It's nested inside the whole-card click target that opens
    // the stop (card.addEventListener("click", ...) below), so its own
    // click listener stops propagation — same pattern as every other
    // nested control inside a bigger tap target in this file (see e.g.
    // buildExceptionInlineForm_) — otherwise tapping "Map" would ALSO open
    // the stop screen underneath the new tab. No address on file -> no
    // button, same as the stop-detail screen's own address link.
    const right = document.createElement("div");
    right.className = "stop-card-right";
    right.appendChild(pill);
    if (stop.address) {
      const mapBtn = document.createElement("a");
      mapBtn.className = "stop-card-map-btn";
      mapBtn.href = mapsUrlForAddress_(stop.address);
      mapBtn.target = "_blank";
      mapBtn.rel = "noopener";
      mapBtn.textContent = "Map";
      mapBtn.setAttribute("aria-label", "Open " + stop.customer_name + "'s address in Maps");
      mapBtn.addEventListener("click", (e) => e.stopPropagation());
      right.appendChild(mapBtn);
    }

    card.appendChild(left);
    card.appendChild(right);

    card.addEventListener("click", () => openStopScreen_(stop));
    list.appendChild(card);
  });
}

// Racks before orders, per G's "have it say x racks, x orders (just show
// racks before orders)" — was "X orders · X racks expected" (orders first,
// with "expected"); now "X racks, X orders" (racks first, no "expected").
function stopMetaLine_(stop) {
  const orderCount = stop.orders ? stop.orders.length : 0;
  const orderWord = orderCount === 1 ? "order" : "orders";
  const racksVal = stop.racks_expected != null ? stop.racks_expected : "?";
  const rackWord = stop.racks_expected === 1 ? "rack" : "racks";
  return racksVal + " " + rackWord + ", " + orderCount + " " + orderWord;
}

// Google's universal maps link (google.com/maps/search) — not a
// platform-specific geo: or maps: URI — per G's "check if it would work well
// on an android tablet because i think the drivers are actually using
// android not ipad - just make it look good and work well on both." This
// same https:// URL works as a tap target on both platforms: Android and iOS
// both intercept it and hand off to whichever maps app is installed (Google
// Maps on Android, Google Maps or Apple Maps on iOS), falling back to a
// plain browser tab with Google Maps if no app claims it — no user-agent
// sniffing or platform branch needed.
function mapsUrlForAddress_(address) {
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(address);
}

// Splits an ERP-sourced "street, city, state, zip"-shaped address string and
// appends it to `container` as DOM nodes with the city (the 2nd comma-
// separated segment) wrapped in <b>, per G's "mark the city on the stop
// cards bold". Built with createTextNode/a real <b> element, never
// innerHTML — this is ERP-sourced text, never trusted as markup (same rule
// renderStopLiveLabels_ follows for the stop-detail screen's notes). Falls
// back to plain text if the address doesn't have at least a
// "street, city" shape to split on, so a short/malformed address never
// throws, it just isn't bolded.
function appendAddressWithBoldCity_(container, address) {
  const parts = address.split(",");
  if (parts.length < 2) {
    container.appendChild(document.createTextNode(address));
    return;
  }
  const before = parts[0] + ", ";
  const city = parts[1].trim();
  const after = parts.length > 2 ? "," + parts.slice(2).join(",") : "";
  container.appendChild(document.createTextNode(before));
  const cityEl = document.createElement("b");
  cityEl.textContent = city;
  container.appendChild(cityEl);
  container.appendChild(document.createTextNode(after));
}

function statusToClass_(status) {
  // Both done states render identically now — green — per G's "mark green
  // if delivered." Now that the pill's TEXT always says "Delivered" (see
  // statusToLabel_ below), a still-different RED color for done_exceptions
  // read as visually contradictory — a card that says "Delivered" but looks
  // like something's wrong. The done_clean vs done_exceptions distinction
  // still lives in the data (the Sheet row, the PDF, the Exceptions Log) —
  // this only changes what color the route list itself shows.
  if (status === "done_clean" || status === "done_exceptions") return "done";
  return "pending";
}
function statusToLabel_(status) {
  // Both done states say "Delivered" — per G's "it should not be labeled
  // differently - its either delivered or not." Once a stop is submitted,
  // the driver's work is done whether or not exceptions were flagged; the
  // exceptions detail still surfaces via the actual Sheet/PDF/Exceptions Log
  // records (see statusToClass_ above — the route list's own color is now
  // green for either done state), just never as a different pill label.
  if (status === "done_clean" || status === "done_exceptions") return "Delivered";
  return "Pending";
}

// ==================================================================
// STOP DETAIL SCREEN
// ==================================================================
function wireStopScreen() {
  document.getElementById("stop-back-btn").addEventListener("click", () => {
    renderRouteList_();
    showScreen_("screen-route");
  });

  const racksInput = document.getElementById("racks-unloaded-input");
  racksInput.addEventListener("input", () => {
    // text + inputmode=numeric + pattern=[0-9]* (same combo as the
    // qty-affected field on the exceptions screen — see PROJECT-NOTES.md)
    // gets a true digits-only keypad on iPad Safari, but type="text" does no
    // numeric validation of its own, so strip anything non-digit as it's typed.
    const digitsOnly = racksInput.value.replace(/[^0-9]/g, "");
    if (digitsOnly !== racksInput.value) racksInput.value = digitsOnly;
    const btn = document.getElementById("to-signature-btn");
    btn.disabled = racksInput.value === "" || Number(racksInput.value) < 0;
    renderStopWarnings_();
  });

  // Search box — filters the item list by name as the driver types. Just
  // re-renders the list on every keystroke; the list is short enough per
  // stop that this doesn't need debouncing.
  const itemSearchInput_ = document.getElementById("item-search-input");
  const itemSearchClearBtn_ = document.getElementById("item-search-clear-btn");
  itemSearchInput_.addEventListener("input", (e) => {
    itemSearchText_ = e.target.value;
    syncSearchClearBtn_(itemSearchInput_, itemSearchClearBtn_);
    if (currentStop) renderItemPickList_(currentStop);
  });
  // Clear ("x") button — per G's "Add x to search bars... button i can click
  // to clear search bar." Refocuses the box afterward so a driver can start
  // typing a new search immediately instead of having to tap back into it.
  itemSearchClearBtn_.addEventListener("click", () => {
    itemSearchText_ = "";
    itemSearchInput_.value = "";
    syncSearchClearBtn_(itemSearchInput_, itemSearchClearBtn_);
    itemSearchInput_.focus();
    if (currentStop) renderItemPickList_(currentStop);
  });

  // Count Items toggle — per G's "Make possible to count items... add button
  // 'count items' -> checkbox to click appears for each row." Toggling this
  // only shows/hides the per-row checkboxes (renderItemPickList_); it never
  // clears countedItems, so a driver can turn it off to see the full invoice
  // view mid-count and turn it back on without losing progress.
  document.getElementById("count-items-toggle-btn").addEventListener("click", () => {
    countModeActive = !countModeActive;
    syncCountItemsBtn_();
    if (currentStop) renderItemPickList_(currentStop);
  });

  // "Add Item" toggle + search — per G's "add the option to add items on the
  // view." The catalog itself is now prefetched way back in init() (see the
  // comment there), so in the normal case itemsCatalog_ is already populated
  // by the time this is ever tapped and the panel opens with instant
  // results, no loading wait. The fetch here is just a defensive fallback
  // for the rare case a driver opens the panel before that background fetch
  // has resolved (e.g. tapping through very fast right after login). See the
  // ADD ITEM section further down for
  // syncAddItemPanel_/loadItemsCatalog_/renderAddItemResults_/addCatalogItem_.
  document.getElementById("add-item-toggle-btn").addEventListener("click", () => {
    addItemPanelOpen_ = !addItemPanelOpen_;
    syncAddItemPanel_();
    if (addItemPanelOpen_ && !itemsCatalog_) {
      loadItemsCatalog_().then(() => {
        if (addItemPanelOpen_) renderAddItemResults_();
      });
    }
  });
  const addItemSearchInput_ = document.getElementById("add-item-search-input");
  const addItemSearchClearBtn_ = document.getElementById("add-item-search-clear-btn");
  addItemSearchInput_.addEventListener("input", (e) => {
    addItemSearchText_ = e.target.value;
    syncSearchClearBtn_(addItemSearchInput_, addItemSearchClearBtn_);
    renderAddItemResults_();
  });
  // Same clear ("x") button pattern as the item-search box above.
  addItemSearchClearBtn_.addEventListener("click", () => {
    addItemSearchText_ = "";
    addItemSearchInput_.value = "";
    syncSearchClearBtn_(addItemSearchInput_, addItemSearchClearBtn_);
    addItemSearchInput_.focus();
    renderAddItemResults_();
  });

  // +/- buttons, grouped together on one side of the input (same pattern as
  // the exceptions screen's qty-affected stepper) — no upper cap here, since
  // unloading more or fewer racks than expected is exactly the mismatch
  // renderStopWarnings_() is meant to surface, not something to block.
  function setRacksUnloaded_(n) {
    if (!isFinite(n) || n < 0) n = 0;
    racksInput.value = String(n);
    racksInput.dispatchEvent(new Event("input"));
  }
  document.getElementById("racks-minus-btn").addEventListener("click", () => {
    setRacksUnloaded_((racksInput.value === "" ? 0 : Number(racksInput.value)) - 1);
  });
  document.getElementById("racks-plus-btn").addEventListener("click", () => {
    setRacksUnloaded_((racksInput.value === "" ? 0 : Number(racksInput.value)) + 1);
  });

  // Racks + exceptions now live on the same screen (see the HTML comment on
  // screen-stop) — this button used to lead to a separate "Exceptions"
  // screen; it now goes straight to Signature, since flagging happens
  // in-place on this same page via renderItemPickList_/buildExceptionInlineForm_.
  document.getElementById("to-signature-btn").addEventListener("click", () => {
    if (!currentStop) return;
    // Per G's "i have to choose the reason why rejected" — a Rejected line
    // with no sub-reason picked now blocks moving on, instead of silently
    // letting it through with a blank optional field. Expand + scroll to the
    // first offending line rather than just a toast, so the driver lands
    // right on the buttons they need to tap, not left to go hunting for it.
    const missingIdx = findMissingRejectReason_();
    if (missingIdx != null) {
      if (flaggedItems[missingIdx]) flaggedItems[missingIdx].expanded = true;
      renderItemPickList_(currentStop);
      const rowEl = document.querySelector('.item-pick-row[data-idx="' + missingIdx + '"]');
      if (rowEl) rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
      showToast("Pick why this item was rejected before continuing.");
      return;
    }
    currentStop._racksUnloadedEntered = Number(document.getElementById("racks-unloaded-input").value);
    openSignatureScreen_(currentStop);
  });

  // "Print Invoice" no longer has a button on this screen — see
  // wireSignatureScreen's print-pdf-btn-signature for the one and only
  // instance now, per G's "this should be option on the next site."
}

// ==================================================================
// LIVE ROUTE-PLAN REFRESH (2026-09-29, revised 2026-09-30) — per G's
// "Times / truck order / rack number could be changed - should be
// displayed on the app... make it somehow so that when changes made here
// it updates in the app - for example delivery times get changed after
// prep already done etc - changes should still arrive - item data still ok
// to get from the erp and it doesnt change after thats ok but the truck
// and delivery data should be based on the live erp export." Code.gs
// re-reads ERP-outFuture LIVE and rebuilds truck/driver/time/rack/address/
// $-total data off it (see buildLiveRouteStops_ in Code.gs for the backend
// half and exactly which fields are live vs static) — this is the frontend
// half: a periodic background re-fetch that merges those fresh fields onto
// the stops already in memory, WITHOUT resetting anything the driver is
// mid-way through (flaggedItems, countedItems, addedItems, a typed racks
// count, a drawn signature, search/filter state) and WITHOUT losing an
// already-submitted stop's local driver_state even if it's momentarily
// missing from a later live fetch (see refreshRoutePlanLive_'s own merge-
// policy comment below).
//
// REVISED 2026-09-30, per G's "it should not be pulled fresh on every
// request! the app still should work offline - this should be more of a
// thing if there is good connection etc it reads the live data again but
// without slowing the app down": from 2026-09-29 to today, this same live
// ERP-outFuture rebuild ALSO ran inline on the app's main, blocking
// get_trucks/get_route_plan load — meaning the app's core "show me my
// route" path depended on a live Sheets read succeeding (and being fast),
// working against the offline-first design described at the top of this
// file. That's gone: get_trucks/get_route_plan are pure static file reads
// again (see loadFullRoutePlan_/init() above), and THIS function —
// refreshRoutePlanLive_, hitting its own ?action=get_live_route_updates
// endpoint — is now the ONLY place the live rebuild ever runs. It's called
// once in the background right after the initial load settles (see init(),
// a couple screens up) and then on the timer below — always after the
// driver already has a usable screen, never gating it, and silently
// no-opping on any failure (offline, a slow connection, a backend hiccup)
// rather than surfacing that as a problem.
// ==================================================================
const ROUTE_PLAN_LIVE_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min — ERP-outFuture itself only refreshes every 30 min, 6am-3pm (see its own title-row banner / the ROUTE PLAN section comment in Code.gs), so this is already well ahead of that; going faster buys nothing

// The stable identity a stop keeps across a live refresh, even though
// stop_id ("T4-1"-style) is recomputed from the CURRENT truck+delivery-time
// sort and can change the moment either one does. customer_code doesn't —
// ERP-outFuture groups a whole day's orders for one customer into a single
// stop the same way regardless of which truck/time ends up on it (see
// readErpOutfutureStops_ in Code.gs). stop_id is still sent to the backend
// (Sheet rows, filenames, the printed invoice's own confirmation number)
// and still shown to the driver as a label — it's just no longer trusted as
// a stable identity for anything stored on THIS device. Falls back to
// stop_id itself for the rare stop with no customer_code.
function stopKey_(stop) {
  return (stop && (stop.customer_code || stop.stop_id)) || "";
}

// Per-stop fields that come straight off ERP-outFuture and can legitimately
// change between refreshes — see buildLiveRouteStops_'s own doc comment in
// Code.gs for the exact static/live split this mirrors. Deliberately
// excludes line_items_combined/cart_number/payment_terms/contact_emails/
// phone (static — G confirmed item data doesn't need to be live) and
// driver_state (local-only — see LOCAL DRIVER-STATE PERSISTENCE below;
// never comes from the server in any way that matters here).
const LIVE_STOP_FIELDS_ = [
  "stop_id", "truck", "delivery_time", "customer_name", "address", "ship_state",
  "delivery_instructions", "order_note", "racks_expected", "orders",
  "true_subtotal", "delivery_fee", "true_total",
];

// Fetches the route plan fresh and merges only the LIVE fields (see
// LIVE_STOP_FIELDS_) onto whatever's already in manifest.stops, matched by
// stopKey_ — mutating the existing stop objects IN PLACE rather than
// replacing them, so currentStop (if the driver has a stop screen open)
// picks up the change automatically through its existing reference, no
// separate lookup needed.
//
// Merge policy: a stop the fresh fetch returns is either matched onto an
// existing one (live fields patched in place) or, if genuinely new to this
// device, appended. A stop this device already knows about that's MISSING
// from the fresh fetch is kept, unmodified, rather than removed — dropping
// a stop the driver may have already delivered (or is mid-way through) just
// because one live read didn't include it (a dispatch edit mid-save, a
// transient ERP-outFuture hiccup) is a worse failure than occasionally
// showing one stop a beat stale. A stop genuinely reassigned to a different
// truck doesn't need special handling either — its own `truck` field just
// updates to the new one, and renderRouteList_'s existing per-truck filter
// naturally stops showing it on this driver's list.
//
// Called on a timer (see init()) and whenever the app comes back into view
// (visibilitychange) — same "coming back into view is the natural moment to
// check" reasoning flushOfflineQueue_/reconcileNativeBackgroundSyncs_
// already use for the outgoing side of this same idea.
async function refreshRoutePlanLive_() {
  if (!manifest) return; // nothing loaded yet (still mid-login) — nothing to refresh
  let json;
  try {
    // ?action=get_live_route_updates, NOT get_route_plan (2026-09-30) — the
    // main route-plan fetch (used by loadFullRoutePlan_ above) is back to a
    // fast, pure static file read (see getRoutePlanForRequest_'s own "PURE
    // STATIC AGAIN" comment in Code.gs). This function is now the ONLY
    // place that ever triggers the slower live ERP-outFuture rebuild — and
    // it already runs in the background, non-blocking, failing silently on
    // no connection — exactly the "if there is good connection... without
    // slowing the app down" behavior G asked for.
    const res = await fetch(APPS_SCRIPT_URL + "?action=get_live_route_updates", { cache: "no-store" });
    json = await res.json();
  } catch (err) {
    console.warn("live route-plan refresh failed (network) — keeping what's already loaded", err);
    return;
  }
  if (!json || json.ok === false || !Array.isArray(json.stops)) {
    console.warn("live route-plan refresh returned an error/unexpected shape — keeping what's already loaded", json);
    return;
  }

  const existingByKey = new Map(manifest.stops.map((s) => [stopKey_(s), s]));
  const freshKeys = new Set();
  const merged = json.stops.map((fresh) => {
    const key = stopKey_(fresh);
    freshKeys.add(key);
    const existing = existingByKey.get(key);
    if (existing) {
      LIVE_STOP_FIELDS_.forEach((field) => { existing[field] = fresh[field]; });
      return existing;
    }
    return fresh; // brand-new stop, not previously known on this device
  });
  // Keep any previously-known stop the fresh fetch didn't return — see the
  // merge-policy comment above.
  manifest.stops.forEach((s) => { if (!freshKeys.has(stopKey_(s))) merged.push(s); });
  manifest.stops = merged;
  // A stop that was briefly missing from one live fetch and then reappears
  // arrives above as a brand-new object (the "return fresh" branch, not the
  // preserved-by-reference "existing" branch), so it has no driver_state on
  // it yet. Re-apply anything already saved locally for it so it doesn't
  // look reset/unsubmitted just because of a transient ERP-outFuture gap.
  applyStoredDriverState_();

  manifest.trucks = json.trucks || manifest.trucks;
  manifest.truck_drivers = json.truck_drivers || manifest.truck_drivers;
  manifest.truck_start_times = json.truck_start_times || manifest.truck_start_times;
  truckDriverNames_ = manifest.truck_drivers;
  truckStartTimes_ = manifest.truck_start_times;

  saveRoutePlanCache_(manifest, pins);

  // Re-render whatever's actually on screen so the change is visible right
  // away, without disturbing anything the driver is mid-edit on —
  // renderStopLiveLabels_ (below) deliberately touches only labels, never
  // the racks-unloaded INPUT value or any flagged/counted/added state.
  const routeScreenActive = document.getElementById("screen-route").classList.contains("active");
  if (routeScreenActive) renderRouteList_();
  const stopScreenActive = document.getElementById("screen-stop").classList.contains("active");
  if (currentStop && stopScreenActive) {
    renderStopLiveLabels_(currentStop);
    renderStopWarnings_(currentStop);
  }
}

// Sets the header/meta/notes/expected-racks-label text off `stop`'s CURRENT
// fields — split out of openStopScreen_ (2026-09-29) so a live route-plan
// refresh (see refreshRoutePlanLive_) can re-run just this part while the
// driver has this exact stop open, without touching anything openStopScreen_
// also resets on a genuinely new stop (flaggedItems, the racks-unloaded
// INPUT value, search/filter state, the signature pad, ...). Deliberately
// does NOT touch #racks-unloaded-input's value — only the "Expected: N
// racks" LABEL next to it — so a rack-count change arriving mid-entry can
// never overwrite what the driver already typed; see renderStopWarnings_
// for how a resulting mismatch still gets flagged.
function renderStopLiveLabels_(stop) {
  document.getElementById("stop-name").textContent = stop.customer_name;

  const orderNums = (stop.orders || []).map((o) => o.order_number).join(", ");
  // sales_person (2026-09-29, per G's "add sales person here at top based
  // on customers export") — sourced from "ERP(Customers Export)"'s "Sales
  // Person" column (see getCustomerContactMap_/getErpCustomerMap_ in
  // Code.gs), a STATIC field like payment_terms right next to it (not
  // re-looked-up on a live refresh — a customer's assigned rep doesn't
  // change mid-shift). Appended only when present — frequently blank in
  // the real ERP data (not every customer has an assigned rep), and
  // unconditionally appending it here would leave a dangling "· " for
  // those stops, same problem this line already has with payment_terms.
  //
  // The address is now a real tappable link that opens a map (2026-09-29,
  // per G's "Make so map opens when clicking on address on stop") — same
  // "make it a real tap target, not inert text" reasoning as the phone
  // number link above in this function. Built with DOM nodes rather than
  // one textContent string, same "ERP-sourced text is never trusted as
  // markup" rule as everywhere else here — the address itself still goes
  // in via textContent on the anchor, never innerHTML.
  const metaEl = document.getElementById("stop-meta");
  metaEl.innerHTML = "";
  if (stop.address) {
    const addrLink = document.createElement("a");
    addrLink.className = "address-link";
    addrLink.href = mapsUrlForAddress_(stop.address);
    addrLink.target = "_blank";
    addrLink.rel = "noopener";
    addrLink.textContent = stop.address;
    metaEl.appendChild(addrLink);
  } else {
    metaEl.appendChild(document.createTextNode(stop.address || ""));
  }
  metaEl.appendChild(document.createTextNode(
    " · Order" + ((stop.orders || []).length === 1 ? "" : "s") + " " + orderNums +
    " · " + (stop.payment_terms || "") +
    (stop.sales_person ? " · Sales: " + stop.sales_person : "")
  ));

  // Order note + delivery instructions at the top of the screen, per G's
  // "show order note at top - not just delivery note" — set here rather
  // than in renderStopWarnings_ (which re-runs on every racks-input
  // keystroke and is for racks-mismatch warnings, a different, dynamic kind
  // of thing). Built with textContent, not innerHTML — this is ERP-sourced
  // text, never trusted as markup.
  const notesBox = document.getElementById("stop-notes");
  notesBox.innerHTML = "";
  // Phone renders first — "at top" per G's ask — as a real tel: link so a
  // driver can tap straight into a call rather than reading a number to
  // dial by hand. Sourced from the "Customer Emails" tab's new phone column
  // (see getCustomerContactMap_ in Code.gs) — same manual-entry pattern as
  // that tab's existing emails column, so a stop with nothing entered there
  // yet just shows no phone line, same as a stop with no order_note.
  if (stop.phone) {
    const p = document.createElement("p");
    p.className = "phone-note";
    const a = document.createElement("a");
    a.href = "tel:" + stop.phone.replace(/[^0-9+]/g, "");
    a.textContent = "Phone: " + stop.phone;
    p.appendChild(a);
    notesBox.appendChild(p);
  }
  if (stop.order_note) {
    const p = document.createElement("p");
    p.textContent = "Order note: " + stop.order_note;
    notesBox.appendChild(p);
  }
  if (stop.delivery_instructions) {
    const p = document.createElement("p");
    p.textContent = "Delivery instructions: " + stop.delivery_instructions;
    notesBox.appendChild(p);
  }

  document.getElementById("racks-expected-label").textContent = stop.racks_expected != null ? stop.racks_expected : "-";
}

function openStopScreen_(stop) {
  // Only clear flagged exceptions when this is actually a different stop
  // (opened fresh from the route list) — not when the driver taps "Back"
  // from the exceptions screen to re-check racks/items on the *same* stop.
  // Resetting unconditionally here used to silently drop already-flagged
  // items on that back-and-forth (see PROJECT-NOTES.md). Compared by
  // stopKey_ (customer_code), not stop_id — as of 2026-09-29 stop_id gets
  // recomputed on every live route-plan refresh (see refreshRoutePlanLive_)
  // whenever a stop's truck or delivery time changes, so comparing it here
  // would wrongly treat "the same stop, just reassigned" as a brand-new
  // stop and wipe out whatever the driver had already flagged/counted/added.
  const isNewStop = !currentStop || stopKey_(currentStop) !== stopKey_(stop);
  currentStop = stop;
  if (isNewStop) {
    flaggedItems = {};
    // Same reasoning applies to the count-off checkboxes, search text, size
    // filters, signature, and rack photo: clear them when starting a
    // genuinely new stop, but leave them alone on a same-stop back-and-forth
    // (e.g. sign -> back to exceptions -> forward to signature again
    // shouldn't wipe a signature already captured, or a driver's half-done
    // item count).
    countedItems = {};
    countModeActive = false;
    itemSearchText_ = "";
    activeSizeFilters_ = {};
    // Same reasoning again: a genuinely new stop starts with no added items
    // and the search panel closed, but reopening the SAME stop (e.g. sign ->
    // back -> forward) must not silently drop an item the driver already
    // added. itemsCatalog_ itself is untouched here on purpose — it's not
    // per-stop state, see its declaration comment.
    addedItems = {};
    addItemPanelOpen_ = false;
    addItemSearchText_ = "";
    clearSignaturePad_();
    clearRackPhoto_();
    clearSkipReason_();
    clearExtraInvoiceEmail_();
  }

  // Header/meta/notes/expected-racks-label — split into its own function
  // (renderStopLiveLabels_, below) so a live route-plan refresh (see
  // refreshRoutePlanLive_) can re-run just this part while the driver has
  // this exact stop open, without re-running anything above that resets
  // driver-entered state on a genuinely new stop.
  renderStopLiveLabels_(stop);

  const racksInput = document.getElementById("racks-unloaded-input");
  // driver_state.racks_unloaded (post-submit truth) wins if it's there;
  // otherwise fall back to _racksUnloadedEntered (set when "Next: Signature"
  // was tapped, before ever reaching the backend) — without this fallback,
  // tapping "Back" from the signature screen mid-flow silently blanked the
  // racks count the driver had already entered, on the very next screen
  // back, which is now a one-tap trip since Signature's back button leads
  // straight here (used to take two back-taps through the old separate
  // Exceptions screen, so it was far less likely to actually come up).
  const savedRacks = (stop.driver_state && stop.driver_state.racks_unloaded != null)
    ? stop.driver_state.racks_unloaded
    : stop._racksUnloadedEntered;
  racksInput.value = savedRacks != null ? savedRacks : "";
  document.getElementById("to-signature-btn").disabled = racksInput.value === "";

  renderStopWarnings_();
  // Search box, size filter buttons, and the Count Items toggle all reflect
  // this stop's own state (reset above on a genuinely new stop, preserved on
  // a same-stop back-and-forth) — synced here, before the list itself is
  // built, since renderItemPickList_ reads itemSearchText_/activeSizeFilters_/
  // countModeActive but doesn't touch these DOM controls.
  renderItemToolbar_(stop);
  // Item list doubles as the invoice review (each row already shows
  // qty/item/size) and the exception-flagging UI — see renderItemPickList_.
  renderItemPickList_(stop);
  // Items the driver has added that weren't on the original order — its own
  // separate list, kept in sync with addedItems here so a same-stop
  // back-and-forth (see the isNewStop comment above) still shows them.
  renderAddedItemsList_();
  showScreen_("screen-stop");
}

function getLineItems_(stop) {
  // Combined multi-order stops carry line_items_combined; single-order stops
  // carry line_items on their one order. Swanson's-style gap (an order whose
  // line_items is a string note, not an array) is surfaced as a warning,
  // not silently dropped or fabricated — see PROJECT-NOTES.md section 2.
  if (Array.isArray(stop.line_items_combined)) return stop.line_items_combined;
  if (stop.orders && stop.orders.length === 1 && Array.isArray(stop.orders[0].line_items)) {
    return stop.orders[0].line_items;
  }
  // Multi-order stop with no combined list (Swanson's case): gather whatever
  // arrays exist across its orders.
  const items = [];
  (stop.orders || []).forEach((o) => {
    if (Array.isArray(o.line_items)) items.push(...o.line_items);
  });
  return items;
}

function getStopTotal_(stop) {
  if (stop.true_total != null) return stop.true_total;
  if (stop.orders && stop.orders.length === 1 && stop.orders[0].total != null) return stop.orders[0].total;
  return null;
}

// Same pattern as getStopTotal_ — prefer the stop-level corrected figure
// (multi-order stops), fall back to the single order's own field. Added so
// the PDF can show a Sub Total / Delivery Total breakdown like the ERP's
// own Delivery Note, not just the one combined total the app already showed.
function getStopSubtotal_(stop) {
  if (stop.true_subtotal != null) return stop.true_subtotal;
  if (stop.orders && stop.orders.length === 1 && stop.orders[0].subtotal != null) return stop.orders[0].subtotal;
  return null;
}

function getStopDeliveryFee_(stop) {
  if (stop.delivery_fee != null) return stop.delivery_fee;
  if (stop.orders && stop.orders.length === 1 && stop.orders[0].delivery_fee != null) return stop.orders[0].delivery_fee;
  return null;
}

// Sums qty * unit_price across the driver's added-items state (an object
// keyed by locally-assigned id — see its declaration comment). Per G's
// explicit "Affects the total" — unlike an exception (which only ever
// lowers a line's own Sub Total and leaves the invoiced Total exactly as it
// was), an added item raises what's owed, so its dollar amount has to be
// folded into the printed/emailed total BEFORE it ever reaches Code.gs —
// see this function's two call sites (submitStop_, buildStopPdfPayload_) and
// the matching design-intent comment on buildDeliveryPdfBlob_ in Code.gs,
// which just displays body.total as given rather than recomputing it.
function addedItemsSubtotal_(items) {
  return Object.values(items).reduce((sum, it) => {
    const unitPrice = it.unit_price != null ? Number(it.unit_price) : 0;
    const qty = Number(it.qty) || 0;
    return sum + unitPrice * qty;
  }, 0);
}

// Per G's "remove this text" (the old plain "Racks unloaded (X) doesn't
// match expected (Y)" message, shown for ANY mismatch, over or under) —
// that generic message is gone. In its place: only the over-count case gets
// a warning now — under-counting is a completely normal, expected part of a
// delivery (short/rejected/damaged lines all reduce racks unloaded below
// expected, and that's exactly what the exception flow below already
// covers) but unloading MORE racks than expected is the case actually worth
// a driver double-checking before it's too late to easily fix (wrong truck's
// racks, a miscount) — per G's "If more racks entered - make colored
// message - say something like double check so you are not unloading too
// many racks." Styled distinctly (.stop-warning-caution, amber) rather than
// plain .hint text, so it reads as an actual caution, not routine copy.
function renderStopWarnings_(stop) {
  stop = stop || currentStop;
  if (!stop) return;
  const box = document.getElementById("stop-warnings");
  box.innerHTML = "";

  // total_discrepancy_note / missing-line-items / email_gap_note are
  // internal office-side data-quality flags (surfaced to office in the
  // Manifest Draft tab's review_notes column) — never shown to the driver,
  // who can't act on them anyway. Only driver-actionable warnings below.
  // (delivery_instructions used to be pushed here too, but it's now shown
  // once, up top, in #stop-notes alongside order_note — see openStopScreen_ —
  // so it isn't duplicated here.)

  const racksInput = document.getElementById("racks-unloaded-input");
  const entered = racksInput.value === "" ? null : Number(racksInput.value);
  if (entered != null && stop.racks_expected != null && entered > stop.racks_expected) {
    const p = document.createElement("p");
    p.className = "stop-warning-caution";
    p.textContent = "Double check — you're unloading more racks (" + entered + ") than expected (" + stop.racks_expected + "). Make sure you're not unloading too many.";
    box.appendChild(p);
  }
}

// ==================================================================
// ITEM LIST TOOLBAR — search box, size quick-filters, Count Items toggle.
// Per G's "Add search function, buttons to quick filter 2in, 4in" and "Make
// possible to count items." All three only affect what renderItemPickList_
// displays/orders below; none of them touch flaggedItems.
// ==================================================================

// Reflects countModeActive onto the toggle button's own label/selected
// state. Split out from the click handler so openStopScreen_ (via
// renderItemToolbar_) can sync it too, since countModeActive is preserved
// (not reset) on a same-stop back-and-forth.
function syncCountItemsBtn_() {
  const btn = document.getElementById("count-items-toggle-btn");
  btn.textContent = countModeActive ? "Done Counting" : "Count Items";
  btn.classList.toggle("selected", countModeActive);
}

// Shows/hides a search box's clear ("x") button based on whether it
// currently has any text — shared by the item-search box and the add-item
// catalog search box. Per G's "Add x to search bars - on right side in the
// bar - basically button i can click to clear search bar."
function syncSearchClearBtn_(inputEl, btnEl) {
  btnEl.classList.toggle("hidden", inputEl.value === "");
}

// Fixed quick-filter sizes, in display order — see the doc comment below
// for why this stays a short fixed list rather than one button per size.
const QUICK_FILTER_SIZES_ = ["2in", "4in", "6in"];
// Sentinel key in activeSizeFilters_ for the "Everything Else" button,
// distinguishing it from a real size string so it can be excluded from the
// "which explicit sizes are active" list wherever that's read.
const OTHER_SIZE_FILTER_KEY_ = "__other__";

// Called once per openStopScreen_ (not on every renderItemPickList_ render)
// since a stop's set of sizes never changes mid-visit — only the buttons'
// "selected" look does, and that's driven by activeSizeFilters_ directly.
//
// Only 2in/4in/6in ever get their own button — a fixed trio, not one per
// distinct size this stop happens to carry. G's original ask named exactly
// two of these ("buttons to quick filter 2in, 4in"), later extended to
// three plus a catch-all ("add 6in and everything else filter button"); an
// earlier pass that tried one button per size actually present, on a stop
// with a wide size mix (10in/14in/2in/3in/4in/5in/6in/8in), produced a
// cluttered 8-button row nobody asked for. A 2in/4in/6in button is simply
// skipped if this stop has no line item of that size, rather than showing
// a filter that would always empty the list. "Everything Else" covers
// every item that ISN'T 2in/4in/6in — including one with no size at all —
// in one button instead of a button per odd size (3in, 5in, 8in, 10in,
// 14in, ...); it only shows up if this stop actually has one of those.
//
// ONE ROW, FILTERS BOTH AREAS (2026-09-29, per G's screenshot of two
// near-identical filter rows + "only keep the top filter buttons - just
// filters both areas"): there used to be a second copy of this exact row
// (renderAddItemSizeFilterButtons_, now removed) built from the full items
// catalog and filtering only the add-item catalog search
// (renderAddItemResults_) through its own separate activeAddItemSizeFilters_
// state. Now this one row/state does both — a tap here re-renders the
// stop's own item pick list AND, if the add-item panel is currently open,
// the add-item catalog results too, via the same activeSizeFilters_. The
// buttons themselves are still built from this STOP's own line items (not
// the full catalog) — unchanged from before this merge — so a size the
// catalog carries but this stop's own order doesn't won't get its own quick
// filter; a driver can still find it by typing in the add-item search box.
function renderSizeFilterButtons_(stop) {
  const row = document.getElementById("size-filter-row");
  row.innerHTML = "";

  const presentSizes = {};
  let hasOtherSizes = false;
  getLineItems_(stop).forEach((item) => {
    const s = (item.size || "").trim();
    if (s && QUICK_FILTER_SIZES_.indexOf(s) !== -1) {
      presentSizes[s] = true;
    } else {
      hasOtherSizes = true;
    }
  });
  const sizes = QUICK_FILTER_SIZES_.filter((s) => presentSizes[s]);

  if (sizes.length === 0 && !hasOtherSizes) {
    row.classList.add("hidden");
    return;
  }
  row.classList.remove("hidden");

  // Re-renders whichever area(s) this filter row now drives — always the
  // item pick list, and the add-item catalog results too when that panel
  // is currently open (no-op otherwise; renderAddItemResults_ just targets
  // a hidden panel's DOM).
  function rerenderFiltered_() {
    renderItemPickList_(stop);
    if (addItemPanelOpen_) renderAddItemResults_();
  }

  sizes.forEach((size) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "size-filter-btn" + (activeSizeFilters_[size] ? " selected" : "");
    btn.textContent = size;
    // Multiple sizes can be active at once (OR'd together in
    // renderItemPickList_/renderAddItemResults_) — tapping just toggles
    // this one size on/off, same pattern as a reason-btn but without the
    // mutual exclusivity.
    btn.addEventListener("click", () => {
      activeSizeFilters_[size] = !activeSizeFilters_[size];
      btn.classList.toggle("selected", !!activeSizeFilters_[size]);
      rerenderFiltered_();
    });
    row.appendChild(btn);
  });

  if (hasOtherSizes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "size-filter-btn" + (activeSizeFilters_[OTHER_SIZE_FILTER_KEY_] ? " selected" : "");
    btn.textContent = "Everything Else";
    // Same OR-with-the-others toggle behavior as a real size button — see
    // renderItemPickList_/renderAddItemResults_ for how this sentinel key
    // is read back out.
    btn.addEventListener("click", () => {
      activeSizeFilters_[OTHER_SIZE_FILTER_KEY_] = !activeSizeFilters_[OTHER_SIZE_FILTER_KEY_];
      btn.classList.toggle("selected", !!activeSizeFilters_[OTHER_SIZE_FILTER_KEY_]);
      rerenderFiltered_();
    });
    row.appendChild(btn);
  }
}

function renderItemToolbar_(stop) {
  const itemSearchInput = document.getElementById("item-search-input");
  itemSearchInput.value = itemSearchText_;
  syncSearchClearBtn_(itemSearchInput, document.getElementById("item-search-clear-btn"));
  syncCountItemsBtn_();
  renderSizeFilterButtons_(stop);
  syncAddItemPanel_();
}

// ==================================================================
// ADD ITEM — per G's "add the option to add items on the view." A driver
// searches the on-device items catalog for something not on the original
// order and adds it. Per G's answers when this was scoped: (1) "Affects the
// total" — an added item raises the printed/emailed total, via
// addedItemsSubtotal_ above, not just something logged for office to sort
// out later; (2) "Search the ERP item catalog" — not freehand text entry,
// so a driver can't fat-finger an item code/price the way a client-only
// business rule change of that consequence would need. The catalog itself
// (buildItemsCatalog_/publishItemsCatalog_/getItemsCatalogForRequest_ in
// Code.gs) is a separate, lean array — no plant_form/barcode — published
// daily alongside the route plan and cached here in localStorage, since a
// driver adding an item needs to search it with zero signal just like
// everything else in this app.
// ==================================================================

// Shows/hides #add-item-panel and reflects addItemPanelOpen_/
// addItemSearchText_ onto the toggle button + search box. Called from
// renderItemToolbar_ (so a same-stop revisit reopens the panel exactly as
// the driver left it, same pattern as syncCountItemsBtn_) and directly from
// the toggle button's own click handler in wireStopScreen.
function syncAddItemPanel_() {
  document.getElementById("add-item-panel").classList.toggle("hidden", !addItemPanelOpen_);
  document.getElementById("add-item-toggle-btn").classList.toggle("selected", addItemPanelOpen_);
  const addItemSearchInput = document.getElementById("add-item-search-input");
  addItemSearchInput.value = addItemSearchText_;
  syncSearchClearBtn_(addItemSearchInput, document.getElementById("add-item-search-clear-btn"));
  if (addItemPanelOpen_) renderAddItemResults_();
}

// Fetches the items catalog once (?action=get_items_catalog) and caches it
// in localStorage, exactly like the route plan cache above — so once it's
// loaded this shift, "Add Item" keeps working instantly through a dead zone,
// straight from the cache. Called proactively from init() (see the comment
// there) so this has almost always already resolved, from cache or a live
// fetch, well before a driver ever opens the Add Item panel — the call in
// the toggle button's own click handler is just a defensive fallback for the
// rare case a driver gets there before this background fetch finishes.
// itemsCatalogLoadPromise_ collapses concurrent callers (the init() prefetch
// racing a fast tap of the toggle button, say) into one request instead of
// two. Returns the catalog array (empty on total failure, never throws) —
// callers re-render off itemsCatalog_ directly rather than this return
// value, since a second concurrent caller awaiting the same promise needs
// the same up-to-date module state anyway.
async function loadItemsCatalog_() {
  if (itemsCatalog_) return itemsCatalog_;
  if (itemsCatalogLoadPromise_) return itemsCatalogLoadPromise_;
  itemsCatalogLoadPromise_ = (async () => {
    try {
      const res = await fetch(APPS_SCRIPT_URL + "?action=get_items_catalog", { cache: "no-store" });
      const json = await res.json();
      if (json && json.ok === false) throw new Error(json.error || "items catalog not available");
      itemsCatalog_ = json;
      try {
        localStorage.setItem(STORAGE_KEY_ITEMS_CATALOG_CACHE, JSON.stringify(json));
      } catch (err) {
        console.warn("could not persist items catalog cache", err);
      }
    } catch (err) {
      console.warn("items catalog fetch failed; falling back to cache", err);
      try {
        const cached = localStorage.getItem(STORAGE_KEY_ITEMS_CATALOG_CACHE);
        itemsCatalog_ = cached ? JSON.parse(cached) : [];
      } catch (err2) {
        itemsCatalog_ = [];
      }
      if (itemsCatalog_.length === 0) {
        showToast("Couldn't load the item catalog — check your connection and try again.");
      }
    }
    itemsCatalogLoadPromise_ = null;
    return itemsCatalog_;
  })();
  return itemsCatalogLoadPromise_;
}

// Renders #add-item-results from itemsCatalog_ + addItemSearchText_. Search
// is empty until the driver types something — the catalog runs 9,000+ rows,
// so nothing is listed by default, only matches. Capped at 40 rendered rows:
// a guard against a too-broad one-letter query producing a huge DOM, not a
// real limit on what can be found (narrowing the search finds it).
function renderAddItemResults_() {
  const box = document.getElementById("add-item-results");
  box.innerHTML = "";

  if (!itemsCatalog_) {
    box.innerHTML = '<p class="hint">Loading item catalog&hellip;</p>';
    return;
  }
  if (itemsCatalog_.length === 0) {
    box.innerHTML = '<p class="hint">Item catalog isn’t available right now — check your connection and reopen this panel.</p>';
    return;
  }

  const q = addItemSearchText_.trim().toLowerCase();
  // Size filters — activeSizeFilters_, the SAME shared state the top
  // filter row (renderSizeFilterButtons_) also uses for the stop's own item
  // pick list (2026-09-29, per G's "only keep the top filter buttons - just
  // filters both areas"; there used to be a second, separate row/state just
  // for this catalog search). Can narrow the catalog on its own, without any
  // typed text, same as it does on the item pick list. Only block on "type
  // to search" when NEITHER a search term nor a size filter is active —
  // otherwise a size-only browse (e.g. "just show me every 4in item") would
  // be impossible.
  const activeAddSizes = Object.keys(activeSizeFilters_).filter((s) => s !== OTHER_SIZE_FILTER_KEY_ && activeSizeFilters_[s]);
  const addOtherActive = !!activeSizeFilters_[OTHER_SIZE_FILTER_KEY_];
  const hasSizeFilter = activeAddSizes.length > 0 || addOtherActive;
  if (!q && !hasSizeFilter) {
    box.innerHTML = '<p class="hint">Type to search the item catalog.</p>';
    return;
  }

  let matches = itemsCatalog_.filter((it) => (
    !q ||
    (it.item_name || "").toLowerCase().indexOf(q) !== -1 ||
    (it.common_name || "").toLowerCase().indexOf(q) !== -1 ||
    (it.item_code || "").toLowerCase().indexOf(q) !== -1
  ));
  if (hasSizeFilter) {
    matches = matches.filter((it) => {
      const size = (it.size || "").trim();
      if (activeAddSizes.indexOf(size) !== -1) return true;
      if (addOtherActive && QUICK_FILTER_SIZES_.indexOf(size) === -1) return true;
      return false;
    });
  }
  matches = matches.slice(0, 40);

  if (matches.length === 0) {
    box.innerHTML = '<p class="hint">No items match your search.</p>';
    return;
  }

  matches.forEach((it) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "add-item-result-row";

    const label = document.createElement("span");
    label.className = "add-item-result-label";
    label.textContent = it.item_name + (it.size ? " (" + it.size + ")" : "") + (it.common_name ? " — " + it.common_name : "");
    row.appendChild(label);

    const price = document.createElement("span");
    price.className = "add-item-result-price";
    price.textContent = it.unit_price != null ? "$" + Number(it.unit_price).toFixed(2) : "";
    row.appendChild(price);

    row.addEventListener("click", () => addCatalogItem_(it));
    box.appendChild(row);
  });
}

// Adds a catalog item to addedItems (qty 1) — or, if this exact item_code is
// already on the added list, just bumps its qty by one instead of creating
// a second row for it, matching how a driver would think about tapping the
// same result twice ("one more of these"), not a literal tap-by-tap log.
// Either way the row is left expanded (see renderAddedItemsList_) — tapping
// a search result is the driver asking to set a qty right now, per G's "it
// needs to show me immediately where i can choose qty."
function addCatalogItem_(it) {
  const existingEntry = it.item_code ? Object.entries(addedItems).find(([, a]) => a.item_code === it.item_code) : null;
  let id;
  if (existingEntry) {
    id = existingEntry[0];
    existingEntry[1].qty = (Number(existingEntry[1].qty) || 0) + 1;
    existingEntry[1].expanded = true;
  } else {
    id = "a" + (addedItemIdCounter_++);
    addedItems[id] = {
      item_code: it.item_code || "",
      item_name: it.item_name || "",
      common_name: it.common_name || "",
      size: it.size || "",
      unit_price: it.unit_price != null ? it.unit_price : null,
      qty: 1,
      notes: "",
      expanded: true,
    };
  }
  renderAddedItemsList_();
  showToast((it.item_name || "Item") + " added.");
  // Per G's "this transition needs to be more smooth - otherwise it bops up
  // somewhere at bottom of screen and i dont even know i actually added item
  // and where to add qty etc" — the toast alone wasn't enough: the Added
  // Items section can sit well below a long catalog-search results list, so
  // the newly-expanded qty control landed off-screen with nothing drawing
  // the eye to it. Now the app scrolls straight to that row and briefly
  // flashes it (see .just-added-flash in style.css) so it's unmistakable
  // both THAT an item was added and WHERE its qty control is.
  scrollToAddedItemRow_(id);
}

function scrollToAddedItemRow_(id) {
  const rowEl = document.querySelector('.added-item-row[data-id="' + id + '"]');
  if (!rowEl) return;
  rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
  rowEl.classList.add("just-added-flash");
  setTimeout(() => rowEl.classList.remove("just-added-flash"), 1200);
}

// Shared by renderAddedItemsList_ (initial render) and buildAddedItemDetail_'s
// qty stepper (in-place update, so typing doesn't lose input focus) — same
// "collapsed still shows the useful summary" idea as updateItemPickStatus_
// for flagged lines. Qty lives here (not in the label) precisely because
// this is the piece that updates in place as the stepper changes — the
// label itself is only ever set once, at render time.
function updateAddedItemStatus_(statusEl, it, expanded) {
  const lineTotal = it.unit_price != null ? Number(it.unit_price) * (Number(it.qty) || 0) : null;
  const priceText = lineTotal != null ? "$" + lineTotal.toFixed(2) : "";
  statusEl.textContent = "Qty " + it.qty + (priceText ? " · " + priceText : "") + " " + (expanded ? "▾" : "▸");
}

// Renders #added-items-list from addedItems — kept as its own separate list
// from item-pick-list (see the HTML comment on #added-items-section). Each
// row collapses/expands the same way a flagged line does in
// renderItemPickList_ (per G's "it should be able to minimize the same way
// as when i flag items") — the qty stepper/notes/Remove form only shows
// while that row's own `expanded` flag is true, and tapping the row's main
// button just toggles it, never removes the item.
function renderAddedItemsList_() {
  const section = document.getElementById("added-items-section");
  const list = document.getElementById("added-items-list");
  list.innerHTML = "";

  const entries = Object.entries(addedItems);
  section.classList.toggle("hidden", entries.length === 0);
  if (entries.length === 0) return;

  entries.forEach(([id, it]) => {
    const row = document.createElement("div");
    row.className = "added-item-row";
    row.dataset.id = id; // looked up by scrollToAddedItemRow_ right after adding — see addCatalogItem_

    const main = document.createElement("button");
    main.type = "button";
    main.className = "added-item-main";

    const label = document.createElement("span");
    label.className = "added-item-label";
    label.textContent = it.item_name + (it.size ? " (" + it.size + ")" : "");
    main.appendChild(label);

    const status = document.createElement("span");
    status.className = "added-item-status";
    updateAddedItemStatus_(status, it, !!it.expanded);
    main.appendChild(status);

    main.addEventListener("click", () => {
      it.expanded = !it.expanded;
      renderAddedItemsList_();
    });
    row.appendChild(main);

    if (it.expanded) {
      row.appendChild(buildAddedItemDetail_(it, id, status));
    }

    list.appendChild(row);
  });
}

// The qty-stepper/notes/Remove form for one added item — only appended while
// that row is expanded (see renderAddedItemsList_ above). Stops every click
// from bubbling up to the row's own main button, which would otherwise
// collapse the row mid-edit (same pattern as buildExceptionInlineForm_).
// `status` is that row's own summary span, updated in place on qty changes
// rather than re-rendering the whole list, so typing a multi-digit quantity
// doesn't lose input focus.
function buildAddedItemDetail_(it, id, status) {
  const detail = document.createElement("div");
  detail.className = "added-item-detail";
  detail.addEventListener("click", (e) => e.stopPropagation());

  const stepper = document.createElement("div");
  stepper.className = "qty-stepper";
  const minusBtn = document.createElement("button");
  minusBtn.type = "button";
  minusBtn.className = "qty-step-btn qty-minus";
  minusBtn.textContent = "−";
  minusBtn.setAttribute("aria-label", "Decrease quantity");

  const qtyInput = document.createElement("input");
  qtyInput.type = "text";
  qtyInput.inputMode = "numeric";
  qtyInput.pattern = "[0-9]*";
  qtyInput.className = "qty-input";
  qtyInput.value = String(it.qty);

  const plusBtn = document.createElement("button");
  plusBtn.type = "button";
  plusBtn.className = "qty-step-btn";
  plusBtn.textContent = "+";
  plusBtn.setAttribute("aria-label", "Increase quantity");

  // No upper cap (unlike the exception qty-affected field, which is capped
  // at the ordered qty) — there's no "ordered qty" ceiling for something
  // that wasn't on the order at all. Floored at 1 — an added item at qty 0
  // isn't a thing; Remove below is how a driver takes it back off.
  function setQty_(n) {
    if (!isFinite(n) || n < 1) n = 1;
    it.qty = n;
    qtyInput.value = String(n);
    updateAddedItemStatus_(status, it, true);
  }
  minusBtn.addEventListener("click", () => setQty_((Number(it.qty) || 1) - 1));
  plusBtn.addEventListener("click", () => setQty_((Number(it.qty) || 1) + 1));
  qtyInput.addEventListener("input", () => {
    const digitsOnly = qtyInput.value.replace(/[^0-9]/g, "");
    if (digitsOnly !== qtyInput.value) qtyInput.value = digitsOnly;
    setQty_(digitsOnly === "" ? 1 : parseInt(digitsOnly, 10));
  });

  const stepGroup = document.createElement("div");
  stepGroup.className = "qty-step-group";
  stepGroup.appendChild(minusBtn);
  stepGroup.appendChild(plusBtn);
  stepper.appendChild(qtyInput);
  stepper.appendChild(stepGroup);
  detail.appendChild(stepper);

  const notesInput = document.createElement("textarea");
  notesInput.placeholder = "Notes (optional)";
  notesInput.rows = 2;
  notesInput.value = it.notes || "";
  notesInput.addEventListener("input", () => { it.notes = notesInput.value; });
  detail.appendChild(notesInput);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "unflag-btn";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => {
    delete addedItems[id];
    renderAddedItemsList_();
  });
  detail.appendChild(removeBtn);

  return detail;
}

// ==================================================================
// EXCEPTIONS (item flagging) — lives on the same screen as the stop
// detail/racks now (screen-stop); see the HTML comment there and
// openStopScreen_, which calls renderItemPickList_ directly.
// ==================================================================

// The three top-level exception reasons — per G's 2026-09-27 relabel/trim:
// "Short" -> "Missing", "Damaged" -> "Shipping Damage", "Substituted" and
// "Other" removed outright (not just hidden). "Rejected" is the one reason
// with a further, more specific sub-reason — see REJECT_DETAIL_OPTIONS.
const EXCEPTION_REASONS = ["Rejected", "Missing", "Shipping Damage"];
// Only offered/shown when the top-level reason is "Rejected" — per G's "when
// i choose rejected have dropdown with options: damaged leafs, pests, too
// small." Optional (a driver can leave it on the placeholder), since not
// every rejection needs a specific sub-reason on record.
const REJECT_DETAIL_OPTIONS = ["Damaged leafs", "Pests", "Too small"];

// The one place a flagged item's reason gets turned into the string this
// app actually displays/stores/submits everywhere (the collapsed/expanded
// row status, the submit payload, the printed invoice) — folds in
// reject_detail when there is one ("Rejected - Pests"), otherwise just the
// bare top-level reason. ex.reason ITSELF is never this combined string —
// keeping it exactly one of EXCEPTION_REASONS is what lets the reason pill's
// own "selected" check (reason === r) keep working once a sub-reason is
// picked. See buildExceptionInlineForm_/submitStop_/buildStopPdfPayload_.
function exceptionReasonText_(ex) {
  if (ex.reason === "Rejected" && ex.reject_detail) return "Rejected - " + ex.reject_detail;
  return ex.reason;
}

// Returns the flaggedItems key (idx) of the first Rejected line with no
// reject_detail chosen yet, or null if every Rejected line has one — per
// G's "i have to choose the reason why rejected," checked from the Next:
// Signature button in wireStopScreen before letting the driver move on.
// Only Rejected needs this — Missing/Shipping Damage have no sub-reason at
// all (see REJECT_DETAIL_OPTIONS), so they're never in scope here.
function findMissingRejectReason_() {
  for (const idx in flaggedItems) {
    const ex = flaggedItems[idx];
    if (ex.reason === "Rejected" && !ex.reject_detail) return idx;
  }
  return null;
}

// Shared by renderItemPickList_ (initial render / on collapse-expand) and
// buildExceptionInlineForm_ (live updates as the reason pill or qty stepper
// changes, without rebuilding the whole list — see the call sites for why
// that matters). Per G's "when minimized there must be written in row what
// happened," a flagged line's row always names the reason and qty affected,
// collapsed or expanded — not just a bare "Flagged" — so a driver scanning a
// long, mostly-collapsed list can see what's wrong with each line without
// reopening every one of them.
function updateItemPickStatus_(statusEl, ex, expanded) {
  if (!ex) {
    statusEl.textContent = "Tap to flag";
    return;
  }
  const qtyPart = "qty " + (ex.qty_change != null ? ex.qty_change : 0);
  statusEl.textContent = exceptionReasonText_(ex) + " · " + qtyPart + (expanded ? " ▾" : " ▸");
}

// The whole line is one big tap target (not a separate small "Flag" button),
// a flagged line turns red end to end, and its reason/qty/notes form expands
// directly inside that same line — no separate "exception-forms" list
// further down the screen to scroll to and match back up to the right item
// by name. Tapping the line flags it (first tap) or just collapses/expands
// its already-flagged form (every tap after that) — it never unflags; see
// the row click handler below and buildExceptionInlineForm_'s "Remove Flag"
// button for why that's a separate, deliberate action. See PROJECT-NOTES.md.
function renderItemPickList_(stop) {
  const allItems = getLineItems_(stop);
  const list = document.getElementById("item-pick-list");
  list.innerHTML = "";

  // Keep each item's original index (flaggedItems/countedItems are keyed by
  // that original position in allItems, not by position in this filtered/
  // sorted view) while narrowing down to what search + size filters allow.
  let visible = allItems.map((item, idx) => ({ item, idx }));

  const q = itemSearchText_.trim().toLowerCase();
  if (q) {
    visible = visible.filter(({ item }) => (item.item_name || "").toLowerCase().indexOf(q) !== -1);
  }

  // Explicit size buttons (2in/4in/6in) OR'd with "Everything Else" (any
  // size not in that trio, including no size at all) — see
  // renderSizeFilterButtons_ for how these get toggled on.
  const activeSizes = Object.keys(activeSizeFilters_).filter((s) => s !== OTHER_SIZE_FILTER_KEY_ && activeSizeFilters_[s]);
  const otherActive = !!activeSizeFilters_[OTHER_SIZE_FILTER_KEY_];
  if (activeSizes.length > 0 || otherActive) {
    visible = visible.filter(({ item }) => {
      const size = (item.size || "").trim();
      if (activeSizes.indexOf(size) !== -1) return true;
      if (otherActive && QUICK_FILTER_SIZES_.indexOf(size) === -1) return true;
      return false;
    });
  }

  // Count Items mode: a checked-off row sinks to the bottom (stable sort —
  // ties keep their original relative order) so the driver can see at a
  // glance what's left to count, per G's "checkbox to click appears for each
  // row -> move to bottom when checked."
  if (countModeActive) {
    visible.sort((a, b) => {
      const aDone = !!countedItems[a.idx];
      const bDone = !!countedItems[b.idx];
      if (aDone === bDone) return 0;
      return aDone ? 1 : -1;
    });
  }

  visible.forEach(({ item, idx }) => {
    const flagged = !!flaggedItems[idx];
    const counted = !!countedItems[idx];
    const row = document.createElement("div");
    row.className = "item-pick-row" + (flagged ? " flagged" : "") + (counted ? " counted" : "");
    row.dataset.idx = idx; // looked up by findMissingRejectReason_'s caller to scroll a driver back to a Rejected line with no reason picked yet

    // Wraps the optional checkbox + the main tap target side by side — see
    // the .item-pick-top CSS comment for why this is its own inner wrapper
    // rather than making .item-pick-row itself a flex row.
    const topWrap = document.createElement("div");
    topWrap.className = "item-pick-top";

    if (countModeActive) {
      const checkboxLabel = document.createElement("label");
      checkboxLabel.className = "item-count-checkbox";
      // Stops the tap from also reaching .item-pick-main's own click
      // handler, which would flag the line — checking this box should only
      // ever mean "counted," nothing else.
      checkboxLabel.addEventListener("click", (e) => e.stopPropagation());
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = counted;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          countedItems[idx] = true;
        } else {
          delete countedItems[idx];
        }
        renderItemPickList_(stop);
      });
      checkboxLabel.appendChild(checkbox);
      topWrap.appendChild(checkboxLabel);
    }

    const main = document.createElement("button");
    main.type = "button";
    main.className = "item-pick-main";

    const label = document.createElement("span");
    label.className = "item-pick-label";
    label.textContent = item.qty + "x " + item.item_name + (item.size ? " (" + item.size + ")" : "");
    main.appendChild(label);

    const expanded = flagged && flaggedItems[idx].expanded;
    const status = document.createElement("span");
    status.className = "item-pick-status";
    updateItemPickStatus_(status, flaggedItems[idx], expanded);
    main.appendChild(status);

    // Tapping the line only ever flags it (first tap) or collapses/expands
    // its already-flagged form (every tap after that) — it never unflags.
    // That was a real problem: a driver tapping the line again just to
    // shrink it back down (once the reason/qty/notes were filled in, to see
    // more of the list without scrolling) was silently deleting the whole
    // exception. Unflagging now only happens via the explicit "Remove Flag"
    // button inside the expanded form (see buildExceptionInlineForm_) — a
    // deliberate action, not a side effect of tidying up the view.
    main.addEventListener("click", () => {
      if (flaggedItems[idx]) {
        flaggedItems[idx].expanded = !flaggedItems[idx].expanded;
      } else {
        flaggedItems[idx] = {
          item_code: item.item_code || "",
          item_name: item.item_name,
          size: item.size || "",
          qty: item.qty,
          reason: "Rejected",
          reject_detail: "", // only meaningful when reason === "Rejected" — see EXCEPTION_REASON_DETAILS
          // Defaults to 1, not the full ordered qty, per G's "default qty
          // always only 1" — most flags are "one plant in this line," not
          // the whole line; the stepper below is still there to bump it up
          // for the real multi-unit case.
          qty_change: 1,
          notes: "",
          expanded: true,
        };
      }
      renderItemPickList_(stop);
    });
    topWrap.appendChild(main);
    row.appendChild(topWrap);

    if (expanded) {
      row.appendChild(buildExceptionInlineForm_(flaggedItems[idx], idx, stop, status));
    }

    list.appendChild(row);
  });

  if (allItems.length === 0) {
    // Was "— see the note on the previous screen," pointing at a note that
    // doesn't actually exist anywhere in this app (2026-09-30, per G's "check
    // why there is no items" on a real stop showing this exact message).
    // getLineItems_ returning empty here means mergeStopsWithPdfData_
    // (Code.gs) found no matching order block for this order in the day's
    // PDF when "Create Route Plan..." last ran — a known, tracked gap (see
    // PROJECT-NOTES.md) — and it DOES write a specific reason for it (e.g.
    // "No PDF match for order #... — line items missing for that order"),
    // but only into the "Route Plan" Sheet tab's notes column for office,
    // never into the published route plan the driver's app reads (see
    // publishRoutePlan_) — a deliberate call from 2026-09-23 to keep
    // office-only data-quality text off the driver's screen (see
    // PROJECT-NOTES.md). So there genuinely is no note on this or any other
    // screen for a driver to go find; telling them to look for one was
    // simply wrong. Now says what's actually true and gives an actual next
    // step available right here, rather than sending the driver hunting for
    // something that isn't there.
    list.innerHTML = '<p class="hint">No line items on file for this stop — the office\'s route-plan build didn\'t find a matching order in today\'s PDF. Check with the office, or use "+ Add Item" below to enter what\'s actually being delivered.</p>';
  } else if (visible.length === 0) {
    list.innerHTML = '<p class="hint">No items match your search/filter.</p>';
  }
}

// The reason/qty/notes form for one flagged line, built fresh each render
// and appended directly under that line's own row (see renderItemPickList_).
// Every control here stops its click from bubbling up to the row's own
// collapse/expand handler, so tapping a reason button or the qty field just
// changes that field, nothing more. `statusEl` is that row's own summary
// span (the same one renderItemPickList_ builds) — reason/qty changes below
// update it directly in place rather than calling renderItemPickList_ again,
// which would rebuild the entire list (every row, every tap) just to change
// a few words of text, and interrupt a driver mid-tap on the +/- buttons.
function buildExceptionInlineForm_(ex, idx, stop, statusEl) {
  const form = document.createElement("div");
  form.className = "exception-inline";
  form.addEventListener("click", (e) => e.stopPropagation());

  // "Rejected" IS the dropdown now — per G's same-day follow-up, "the why
  // rejected dropdown should be in the rejected button - so i click the
  // rejected button but then i actually choose from dropdown!" The first
  // 2026-10-02 pass still had a separate "Why rejected?" dropdown below a
  // plain "Rejected" button, which wasn't what was asked for — this
  // collapses the two into ONE control, reading "Rejected" in its closed
  // state until a specific reason is picked, then showing that reason
  // directly. Tapping ANY of its options (including the bare "Rejected"
  // placeholder) sets ex.reason to "Rejected" in the same action; picking
  // one of the 3 real options also sets ex.reject_detail. Missing/Shipping
  // Damage stay plain buttons, unchanged — this is scoped to Rejected only,
  // per G's "number 2 but only on the rejected button." Still required, not
  // optional: findMissingRejectReason_ (called from the Next: Signature
  // button in wireStopScreen) blocks moving on until a Rejected line has
  // picked one of the 3 real options, not just left on the bare "Rejected"
  // placeholder.
  //
  // 2026-10-06 correction: this was first built as a plain styled <select>
  // (appearance:none + a CSS background-image caret) — worked fine in the
  // desktop Playwright tests, but on a real Android tablet it rendered as a
  // solid red pill with the OS's own native dropdown-arrow texture tiled
  // repeatedly across the whole width, fighting with the "Rejected" text
  // (an Android WebView/Chrome quirk where the native select chrome isn't
  // fully suppressed by appearance:none, so our custom background painted
  // underneath/behind it instead of replacing it). Fixed with the standard
  // "real select, fake visible button" pattern instead of fighting
  // appearance any further: the actual <select> (`rejectedSelectInput`) is
  // stretched to cover the whole pill but made fully invisible
  // (opacity: 0 in CSS) — it still receives every tap/click and still opens
  // the device's real native picker, so none of the existing value/
  // mousedown/change logic below had to change — while a separate plain
  // `<span>` (`rejectedLabel`, pointer-events: none so taps pass straight
  // through to the select beneath it) is the only thing actually painted,
  // showing "Rejected" or the picked sub-reason in plain text with one
  // small CSS-drawn triangle caret (`.reason-select-rejected-label::after`
  // in style.css) — nothing native-drawn is visible at all anymore, so
  // there's no OS chrome left to fight on any device.
  const otherReasonButtons = [];

  function syncRejectedSelectClass_() {
    rejectedWrap.className = "reason-btn reason-select-rejected" + (ex.reason === "Rejected" ? " selected" : "");
  }
  function syncRejectedLabelText_() {
    rejectedLabel.textContent = rejectedSelectInput.options[rejectedSelectInput.selectedIndex].textContent;
  }

  const rejectedWrap = document.createElement("div");
  const rejectedLabel = document.createElement("span");
  rejectedLabel.className = "reason-select-rejected-label";
  const rejectedSelectInput = document.createElement("select");
  rejectedSelectInput.className = "reason-select-rejected-input";
  const rejectedPlaceholderOpt = document.createElement("option");
  rejectedPlaceholderOpt.value = "";
  rejectedPlaceholderOpt.textContent = "Rejected";
  rejectedSelectInput.appendChild(rejectedPlaceholderOpt);
  REJECT_DETAIL_OPTIONS.forEach((opt) => {
    const optionEl = document.createElement("option");
    optionEl.value = opt;
    optionEl.textContent = opt;
    rejectedSelectInput.appendChild(optionEl);
  });
  rejectedSelectInput.value = ex.reason === "Rejected" ? (ex.reject_detail || "") : "";
  syncRejectedSelectClass_();
  syncRejectedLabelText_();
  // "change" alone isn't enough: if the line is currently Missing/Shipping
  // Damage (so the select sits on its blank "Rejected" placeholder, value
  // ""), and the driver reopens the dropdown and taps that SAME placeholder
  // again without picking a real sub-reason, the native <select> never fires
  // "change" (its value didn't move) — so ex.reason would silently stay
  // Missing/Shipping Damage even though the box now visually shows
  // "Rejected." "mousedown" fires the instant the control is tapped, before
  // the native picker even opens, so it's what actually makes "I click the
  // rejected button" (opening this dropdown at all) switch the line to
  // Rejected — exactly as G described it, with "then I choose from dropdown"
  // handled separately below by "change" once a specific reason is picked.
  // Guarded to no-op while already on Rejected, so reopening the dropdown to
  // change an existing pick doesn't wipe out reject_detail first.
  rejectedSelectInput.addEventListener("mousedown", () => {
    if (ex.reason === "Rejected") return;
    ex.reason = "Rejected";
    ex.reject_detail = "";
    rejectedSelectInput.value = "";
    syncRejectedSelectClass_();
    syncRejectedLabelText_();
    otherReasonButtons.forEach((b) => b.classList.remove("selected"));
    updateItemPickStatus_(statusEl, ex, true);
  });
  rejectedSelectInput.addEventListener("change", () => {
    ex.reason = "Rejected";
    ex.reject_detail = rejectedSelectInput.value;
    syncRejectedSelectClass_();
    syncRejectedLabelText_();
    otherReasonButtons.forEach((b) => b.classList.remove("selected"));
    updateItemPickStatus_(statusEl, ex, true);
  });
  rejectedWrap.appendChild(rejectedLabel);
  rejectedWrap.appendChild(rejectedSelectInput);

  const reasonRow = document.createElement("div");
  reasonRow.className = "reason-btn-row";
  reasonRow.appendChild(rejectedWrap);
  ["Missing", "Shipping Damage"].forEach((r) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "reason-btn" + (ex.reason === r ? " selected" : "");
    btn.textContent = r;
    btn.addEventListener("click", () => {
      ex.reason = r;
      // The sub-reason only ever applies to "Rejected" — switching to a
      // different reason clears whatever was picked (rather than leaving a
      // stale "Pests" silently attached to a "Missing" flag) and resets the
      // Rejected select back to its bare placeholder.
      ex.reject_detail = "";
      rejectedSelectInput.value = "";
      syncRejectedSelectClass_();
      syncRejectedLabelText_();
      otherReasonButtons.forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      updateItemPickStatus_(statusEl, ex, true);
    });
    otherReasonButtons.push(btn);
    reasonRow.appendChild(btn);
  });
  form.appendChild(reasonRow);

  // Capped at the ordered qty (ex.qty) — can't reject/flag more units of an
  // item than were actually on the order (see PROJECT-NOTES.md — this needs
  // enforcing here AND again in submitStop_ as a last-line-of-defense clamp,
  // since neither a text input's typed value nor a stepper button is a real
  // constraint on its own).
  const qtyLabel = document.createElement("label");
  qtyLabel.className = "qty-affected-label";
  qtyLabel.textContent = "Qty affected (of " + ex.qty + " ordered)";
  form.appendChild(qtyLabel);

  const stepper = document.createElement("div");
  stepper.className = "qty-stepper";

  const minusBtn = document.createElement("button");
  minusBtn.type = "button";
  minusBtn.className = "qty-step-btn qty-minus";
  minusBtn.textContent = "−";
  minusBtn.setAttribute("aria-label", "Decrease quantity");

  // type="text" + inputmode="numeric" + pattern="[0-9]*" (not type="number")
  // is the combination that actually gets a digits-only keypad on iPad
  // Safari, with no decimal point or +/- key to fumble with — type="number"
  // alone still shows those. Sanitizing pasted/typed input to digits-only in
  // the "input" handler below covers anything the keypad restriction misses.
  const qtyInput = document.createElement("input");
  qtyInput.type = "text";
  qtyInput.inputMode = "numeric";
  qtyInput.pattern = "[0-9]*";
  qtyInput.className = "qty-input";
  qtyInput.value = ex.qty_change != null ? String(ex.qty_change) : "";

  const plusBtn = document.createElement("button");
  plusBtn.type = "button";
  plusBtn.className = "qty-step-btn";
  plusBtn.textContent = "+";
  plusBtn.setAttribute("aria-label", "Increase quantity");

  function setQty_(n) {
    if (!isFinite(n) || n < 0) n = 0;
    if (n > ex.qty) {
      n = ex.qty;
      showToast("Only " + ex.qty + " of this item were ordered — capped at " + ex.qty + ".");
    }
    ex.qty_change = n;
    qtyInput.value = String(n);
    updateItemPickStatus_(statusEl, ex, true);
  }

  minusBtn.addEventListener("click", () => setQty_((ex.qty_change || 0) - 1));
  plusBtn.addEventListener("click", () => setQty_((ex.qty_change || 0) + 1));
  qtyInput.addEventListener("input", () => {
    const digitsOnly = qtyInput.value.replace(/[^0-9]/g, "");
    if (digitsOnly !== qtyInput.value) qtyInput.value = digitsOnly;
    setQty_(digitsOnly === "" ? 0 : parseInt(digitsOnly, 10));
  });

  // Input first, then minus/plus grouped together as one joined control
  // (.qty-step-group) after it — not flanking the input on both sides — so
  // a driver can tap minus/plus repeatedly without moving their thumb
  // across the number itself. See PROJECT-NOTES.md.
  const stepGroup = document.createElement("div");
  stepGroup.className = "qty-step-group";
  stepGroup.appendChild(minusBtn);
  stepGroup.appendChild(plusBtn);

  stepper.appendChild(qtyInput);
  stepper.appendChild(stepGroup);
  form.appendChild(stepper);

  const notesInput = document.createElement("textarea");
  notesInput.placeholder = "Notes (optional)";
  notesInput.rows = 2;
  notesInput.value = ex.notes || "";
  notesInput.addEventListener("input", () => { ex.notes = notesInput.value; });
  form.appendChild(notesInput);

  // The one and only way to actually unflag this line — see the comment on
  // the row's click handler in renderItemPickList_ for why tapping the row
  // itself no longer does this.
  const unflagBtn = document.createElement("button");
  unflagBtn.type = "button";
  unflagBtn.className = "unflag-btn";
  unflagBtn.textContent = "Remove Flag";
  unflagBtn.addEventListener("click", () => {
    delete flaggedItems[idx];
    renderItemPickList_(stop);
  });
  form.appendChild(unflagBtn);

  return form;
}

// ==================================================================
// SIGNATURE SCREEN
// ==================================================================
function wireSignatureScreen() {
  document.getElementById("signature-back-btn").addEventListener("click", () => {
    openStopScreen_(currentStop);
  });
  document.getElementById("clear-sig-btn").addEventListener("click", clearSignaturePad_);
  document.getElementById("submit-btn").addEventListener("click", () => submitStop_(true));
  document.getElementById("skip-sig-btn").addEventListener("click", () => submitStop_(false));

  // There is only ONE print button now — "Print Invoice" — and it
  // always produces the exact same official PDF that gets emailed to the
  // customer on real submit, whether or not this stop has synced yet. Per
  // G: "it should always print the full edited pdf thats also sent by mail
  // when submitted." See printInvoice_ for the synced-vs-unsynced
  // branch. The old separate on-device "Print Copy for Customer" receipt
  // button is gone.
  document.getElementById("print-pdf-btn-signature").addEventListener("click", printInvoice_);
}

// Per G's "on signature page or just prior - display a recap of all
// discrepancies for the customer to see. also display total units and
// dollars being dropped off." Called fresh every time the signature screen
// opens (openSignatureScreen_) — everything it reads (flaggedItems/
// addedItems/line-item qty+price) is already final by then, and nothing on
// this screen itself (signature, rack photo) can change it, so there's no
// need to re-render it live while the driver is on this page.
//
// Per G's "are you bullshitting what is this - what should it say / make it
// basically show this was units and $ before - these changes have been made
// (additions, rejections etc) - this is the new total units and total $ -
// this is how much total $ changed" — a lone "-1 Ficus — Rejected - Pests"
// line under a single total with no "before" to compare it to was
// meaningless to a customer. So this now shows FOUR things in order: (1)
// Before — the as-ordered units/$ with nothing touched yet, (2) Changes — the
// same per-line discrepancy list as before (red = exception, blue = added),
// (3) Now — the new units/$ actually being dropped off today, (4) Total
// change — how much the $ moved, signed and colored the same red/blue way.
// "Before"/"Now" here are both still deliberately DIFFERENT from the
// invoiced Total shown elsewhere (getStopTotal_/payloadTotal in
// buildStopPdfPayload_) — that figure stays at the original invoiced amount
// on purpose, since GrowFlo issues a corrected invoice separately for any
// rejection/short/damage (see the exceptionsNote in Code.gs's
// sendDeliveryEmail_). "Before"/"Now" are both the actual physical qty/value
// (ordered vs. ordered-minus-flagged-plus-added) — a driver/customer
// sanity-check pair, not a billing figure.
function renderDeliveryRecap_(stop) {
  const totalsEl = document.getElementById("recap-totals");
  const discEl = document.getElementById("recap-discrepancies");
  if (!totalsEl || !discEl) return;

  const lineItems = getLineItems_(stop);
  let beforeUnits = 0;
  let beforeDollars = 0;
  let afterUnits = 0;
  let afterDollars = 0;
  let hasUnpriced = false;
  const discrepancyLines = [];

  lineItems.forEach((li, idx) => {
    const orderedQty = Number(li.qty) || 0;
    const noPrice = li.unit_price == null;
    if (orderedQty > 0 && noPrice) hasUnpriced = true;

    beforeUnits += orderedQty;
    if (!noPrice) beforeDollars += Number(li.unit_price) * orderedQty;

    const ex = flaggedItems[idx];
    let deliveredQty = orderedQty;
    if (ex) {
      const qtyChange = Number(ex.qty_change) || 0;
      deliveredQty = Math.max(0, orderedQty - qtyChange);
      discrepancyLines.push({
        label: li.item_name + (li.size ? " (" + li.size + ")" : ""),
        reason: exceptionReasonText_(ex),
        qtyChange: qtyChange,
        notes: ex.notes || "",
      });
    }
    afterUnits += deliveredQty;
    if (!noPrice) afterDollars += Number(li.unit_price) * deliveredQty;
  });

  Object.values(addedItems).forEach((it) => {
    let qty = Number(it.qty);
    if (!isFinite(qty) || qty < 1) qty = 1;
    afterUnits += qty;
    if (it.unit_price != null) afterDollars += Number(it.unit_price) * qty;
    else hasUnpriced = true;
    discrepancyLines.push({
      label: (it.item_name || it.common_name || "Added item") + (it.size ? " (" + it.size + ")" : ""),
      reason: "Added",
      qtyChange: qty,
      notes: it.notes || "",
      isAdded: true,
    });
  });

  const unpricedNote = hasUnpriced ? "Some items have no price on file — not included in these dollar figures." : "";

  totalsEl.innerHTML = "";
  if (discrepancyLines.length === 0) {
    const row = document.createElement("div");
    row.className = "recap-exact-row";
    row.textContent =
      afterUnits + " unit" + (afterUnits === 1 ? "" : "s") + " · $" + afterDollars.toFixed(2) +
      " being dropped off today — delivered exactly as ordered.";
    totalsEl.appendChild(row);
  } else {
    const changeDollars = afterDollars - beforeDollars;
    const changeSign = changeDollars > 0 ? "+" : changeDollars < 0 ? "-" : "";
    const changeClass = changeDollars > 0 ? " recap-change-up" : changeDollars < 0 ? " recap-change-down" : "";

    const beforeRow = document.createElement("div");
    beforeRow.className = "recap-before-row";
    beforeRow.textContent =
      "Before: " + beforeUnits + " unit" + (beforeUnits === 1 ? "" : "s") + " · $" + beforeDollars.toFixed(2);
    totalsEl.appendChild(beforeRow);

    const nowRow = document.createElement("div");
    nowRow.className = "recap-now-row";
    nowRow.textContent =
      "Now: " + afterUnits + " unit" + (afterUnits === 1 ? "" : "s") + " · $" + afterDollars.toFixed(2) +
      " being dropped off today";
    totalsEl.appendChild(nowRow);

    const changeRow = document.createElement("div");
    changeRow.className = "recap-change-row" + changeClass;
    changeRow.textContent = "Total change: " + changeSign + "$" + Math.abs(changeDollars).toFixed(2);
    totalsEl.appendChild(changeRow);
  }

  if (unpricedNote) {
    const note = document.createElement("div");
    note.className = "recap-unpriced-note";
    note.textContent = unpricedNote;
    totalsEl.appendChild(note);
  }

  discEl.innerHTML = "";
  if (discrepancyLines.length > 0) {
    const changesTitle = document.createElement("div");
    changesTitle.className = "recap-changes-title";
    changesTitle.textContent = "Changes:";
    discEl.appendChild(changesTitle);
    discrepancyLines.forEach((d) => {
      const row = document.createElement("div");
      row.className = "recap-disc-row" + (d.isAdded ? " recap-disc-added" : "");
      const qtySign = d.isAdded ? "+" : "-";
      row.textContent = qtySign + d.qtyChange + " " + d.label + " — " + d.reason + (d.notes ? " (" + d.notes + ")" : "");
      discEl.appendChild(row);
    });
  }
}

function openSignatureScreen_(stop) {
  isSubmitting = false;
  document.getElementById("submit-btn").disabled = false;
  document.getElementById("skip-sig-btn").disabled = false;
  document.getElementById("signature-stop-name").textContent = stop.customer_name;

  renderDeliveryRecap_(stop);

  // The "Print Invoice" row is always visible now — printInvoice_
  // itself decides whether to open the already-synced PDF or generate an
  // on-demand preview from what's currently entered (see printInvoice_).
  showScreen_("screen-signature");
  // The canvas lives inside a ".screen" that is "display:none" until now, so
  // getBoundingClientRect() would return 0x0 (and toDataURL() an empty image)
  // if we sized it back at DOMContentLoaded time. Size it here instead, now
  // that the screen is actually visible. This does NOT also clear the pad —
  // that only happens in openStopScreen_ when it's actually a new stop (see
  // its comment) — a same-stop revisit here must not wipe an already-drawn
  // signature.
  resizeSignaturePad_();
  renderRackPhotoPreview_();
}

let resizeSignaturePad_ = function () {};

function setupSignaturePad() {
  const canvas = document.getElementById("sig-pad");
  const ctx = canvas.getContext("2d");
  sigPad.ctx = ctx;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return; // screen not visible yet — skip, caller retries when it is
    const ratio = window.devicePixelRatio || 1;
    const targetW = Math.round(rect.width * ratio);
    const targetH = Math.round(rect.height * ratio);
    // Setting canvas.width/height clears its bitmap even when set to the
    // same value it already had — so skip re-sizing (and silently wiping
    // an already-drawn signature) when nothing actually changed, e.g. when
    // re-opening this screen for the same stop after a trip to exceptions.
    if (canvas.width === targetW && canvas.height === targetH) return;
    canvas.width = targetW;
    canvas.height = targetH;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1a1a1a";
  }
  resizeSignaturePad_ = resize;
  resize();
  window.addEventListener("resize", resize);
  function pos(evt) {
    const rect = canvas.getBoundingClientRect();
    const point = evt.touches ? evt.touches[0] : evt;
    return { x: point.clientX - rect.left, y: point.clientY - rect.top };
  }

  function start(evt) {
    evt.preventDefault();
    sigPad.drawing = true;
    sigPad.hasStroke = true;
    const p = pos(evt);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }
  function move(evt) {
    if (!sigPad.drawing) return;
    evt.preventDefault();
    const p = pos(evt);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  function end(evt) {
    if (evt) evt.preventDefault();
    sigPad.drawing = false;
  }

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", end, { passive: false });
}

function clearSignaturePad_() {
  const canvas = document.getElementById("sig-pad");
  const ctx = sigPad.ctx;
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  sigPad.hasStroke = false;
}

// ==================================================================
// RACK PHOTO CAPTURE
// ==================================================================
function wirePhotoCapture() {
  const input = document.getElementById("rack-photo-input");
  document.getElementById("take-photo-btn").addEventListener("click", () => input.click());
  document.getElementById("retake-photo-btn").addEventListener("click", () => input.click());

  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.value = ""; // reset so picking the same filename again (a retake) still fires "change"
    if (!file) return;
    try {
      rackPhotoDataUrl = await compressImageFile_(file, 1280, 0.7);
    } catch (err) {
      rackPhotoDataUrl = null;
      showToast("Could not read that photo — try again.");
    }
    renderRackPhotoPreview_();
  });
}

function clearRackPhoto_() {
  rackPhotoDataUrl = null;
  renderRackPhotoPreview_();
}

function clearSkipReason_() {
  const select = document.getElementById("skip-sig-reason-select");
  if (select) select.value = "";
}

// Per G's "on submit page add option for driver to type in a different
// email to send the final invoice to" — reset the same way the skip-reason
// select/signature pad/rack photo are, on a genuinely new stop only (see
// openStopScreen_), never on a same-stop back-and-forth.
function clearExtraInvoiceEmail_() {
  const input = document.getElementById("extra-invoice-email-input");
  if (input) input.value = "";
}

// Loose but real email-shape check — enough to catch an obvious typo (a
// missing "@" or "." , a stray space) before it's queued for a background
// send with no way for the driver to notice or fix it later. Not a strict
// RFC validator; nothing here needs that level of rigor.
function isPlausibleEmail_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function renderRackPhotoPreview_() {
  const img = document.getElementById("rack-photo-preview");
  const takeBtn = document.getElementById("take-photo-btn");
  const retakeBtn = document.getElementById("retake-photo-btn");
  if (!img || !takeBtn || !retakeBtn) return; // called once before DOMContentLoaded finishes wiring; harmless no-op
  if (rackPhotoDataUrl) {
    img.src = rackPhotoDataUrl;
    img.classList.remove("hidden");
    takeBtn.classList.add("hidden");
    retakeBtn.classList.remove("hidden");
  } else {
    img.src = "";
    img.classList.add("hidden");
    takeBtn.classList.remove("hidden");
    retakeBtn.classList.add("hidden");
  }
}

// Downscales/recompresses a camera photo client-side before it ever becomes
// a data URL — an un-resized iPad photo can be several MB, which is fine as
// a one-off POST but would blow through localStorage's much smaller quota
// (5-10MB total) once a few stops' worth queue up offline (see the offline
// queue notes in PROJECT-NOTES.md). 1280px / JPEG quality 0.7 keeps a typical
// rack photo well under 500KB while still being clearly legible.
function compressImageFile_(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("could not decode image"));
      img.onload = () => {
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (w > maxDim || h > maxDim) {
          const scale = maxDim / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ==================================================================
// SUBMIT
// ==================================================================
let isSubmitting = false; // guards against a double-tap firing two submits for one stop

async function submitStop_(wantsSignature) {
  if (!currentStop || isSubmitting) return;

  const hasSignature = wantsSignature && sigPad.hasStroke;

  // A signature is only truly "captured" when something was actually drawn
  // (hasSignature above already accounts for tapping "Submit Delivery" with
  // nothing drawn, not just the explicit "Submit Without Signature" button).
  // Either way, require a reason rather than silently logging a blank skip.
  const skipReasonSelect = document.getElementById("skip-sig-reason-select");
  const skipReason = skipReasonSelect ? skipReasonSelect.value : "";
  if (!hasSignature && !skipReason) {
    showToast("Pick a reason for the missing signature before submitting.");
    return;
  }

  // Per G's "add option for driver to type in a different email to send
  // the final invoice to" — validated here, before anything is queued, so a
  // typo doesn't quietly fail later inside the background send with no way
  // for the driver to notice (see buildStopPdfPayload_/isPlausibleEmail_
  // and sendDeliveryEmail_ in Code.gs for where this actually gets used).
  const extraEmailInput = document.getElementById("extra-invoice-email-input");
  const extraInvoiceEmail = extraEmailInput ? extraEmailInput.value.trim() : "";
  if (extraInvoiceEmail && !isPlausibleEmail_(extraInvoiceEmail)) {
    showToast("That extra invoice email doesn't look valid — fix it or clear the field before submitting.");
    return;
  }

  isSubmitting = true;
  document.getElementById("submit-btn").disabled = true;
  document.getElementById("skip-sig-btn").disabled = true;

  // Same payload builder printInvoice_'s preview uses (see
  // buildStopPdfPayload_'s own comment) — keeps the real submit and the
  // on-demand preview PDF permanently in lockstep instead of two
  // hand-maintained copies of this same business logic quietly drifting
  // apart. hasSignature here preserves submitStop_'s own "Submit Without
  // Signature" semantics (deliberately discards a drawn signature even if
  // one exists when that button was tapped instead of "Submit Delivery").
  const payload = buildStopPdfPayload_("submit_stop", hasSignature);
  const racksUnloaded = payload.racks_unloaded;
  const exceptions = payload.exceptions;
  const addedItemsPayload = payload.added_items;
  const hasAddedItems = addedItemsPayload.length > 0;

  // An added item gets the same "exceptions" local-state status as a
  // rejected/short/damaged line — both mean this delivery isn't exactly the
  // clean as-invoiced case, and both are logged to the Exceptions Log the
  // same way server-side (see handleSubmitStop_ in Code.gs). This no longer
  // changes the route list's pill COLOR (done_clean/done_exceptions both
  // render green now — see PROJECT-NOTES.md), only the underlying record.
  const newStatus = (exceptions.length > 0 || hasAddedItems) ? "done_exceptions" : "done_clean";
  saveDriverStateLocal_(stopKey_(currentStop), {
    racks_unloaded: racksUnloaded,
    exceptions: exceptions,
    added_items: addedItemsPayload,
    signature_image: payload.signature_image,
    signature_skipped_reason: payload.signature_skipped_reason,
    rack_photo_image: rackPhotoDataUrl,
    signed_at: payload.submitted_at_iso,
    status: newStatus,
  });
  applyStoredDriverState_();

  // The actual send to the backend (build the PDF, save it to Drive, email
  // the customer — a real network round-trip that can take several seconds,
  // longer on a cold Apps Script start) used to be awaited right here, which
  // is what made the driver stare at a spinner for a couple of seconds on
  // every single stop. It no longer blocks the screen: every submit — not
  // just genuine no-signal ones — now goes through the same offline queue
  // built for that case (see OFFLINE QUEUE below). queueOffline_ persists it
  // to localStorage immediately (so it survives a crash/reload even before
  // it's sent), then flushOfflineQueue_ is kicked off WITHOUT awaiting it.
  // flushOfflineQueue_ already does everything the old inline success/fail
  // branch used to do — retries on failure, merges pdf_file_id back into
  // local state so the print button lights up, updates the queue banner,
  // and shows its own "synced" toast once the backend actually confirms —
  // so there's nothing left to branch on here.
  const customerName = currentStop.customer_name;
  queueOffline_(payload);
  flushOfflineQueue_();
  showToast("Saved — sending " + customerName + "'s delivery in the background.");

  isSubmitting = false;
  currentStop = null;
  flaggedItems = {};
  addedItems = {};
  addItemPanelOpen_ = false;
  addItemSearchText_ = "";
  rackPhotoDataUrl = null;
  clearExtraInvoiceEmail_();
  renderRouteList_();
  showScreen_("screen-route");
}

// ==================================================================
// PRINT INVOICE (one button, always the real backend PDF)
// ==================================================================
// Used to be TWO print buttons on this screen — "Print Invoice"
// (the real backend-generated PDF, only shown once a stop had already
// synced) and a separate "Print Copy for Customer" (a simpler receipt
// built entirely on-device, always available, for printing before syncing
// or fully offline). Per G's screenshot + "we have 2 print buttons - we
// should only have one!", then "it should always print the full edited
// pdf thats also sent by mail when submitted": the on-device receipt is
// gone, and this ONE button now always produces the real document —
// already-synced stops open the saved PDF exactly as before; a stop not
// yet synced generates that SAME PDF on demand from the Code.gs backend
// (handlePreviewPdf_, reusing the exact buildDeliveryPdfBlob_ layout code
// handleSubmitStop_'s buildAndSavePdf_ calls) fed with whatever's
// currently on screen. This trades the old receipt's zero-signal
// guarantee for always matching the real emailed document — a deliberate
// choice G made when asked, not an oversight; see fetchPdfBlob_ below for
// how a failed/offline generation is surfaced (a toast, not a silent
// no-op — see the toast-visibility fix elsewhere in this file for why
// that toast is now guaranteed visible).
async function printInvoice_() {
  if (!currentStop) return;

  // Already synced from a previous submit — open the real saved PDF
  // exactly as before, no network round trip needed beyond the fetch
  // itself (same as this always has).
  const fileId = currentStop.driver_state && currentStop.driver_state.pdf_file_id;
  if (fileId) {
    window.open(APPS_SCRIPT_URL + "?action=get_pdf&file_id=" + encodeURIComponent(fileId), "_blank");
    return;
  }

  const payload = buildStopPdfPayload_("preview_pdf");
  if (!payload) return;

  const printBtn = document.getElementById("print-pdf-btn-signature");
  const originalLabel = printBtn.textContent;
  printBtn.disabled = true;
  printBtn.textContent = "Generating…";
  try {
    const result = await fetchPdfBlob_(payload);
    if (!result.blob) {
      // 2026-09-30, per G: "i clicked it, loaded couple seconds then said
      // couldnt load invoice check you internet connection but im
      // connected to fast internet - this should work offline anyway."
      // fetchPdfBlob_ used to collapse EVERY failure (a real network/
      // offline failure, an HTTP error, and the backend's own {ok:false}
      // error body) into a bare null, so this toast always blamed the
      // connection even when the connection was fine and the server had
      // actually responded with a specific reason — which is almost
      // certainly what G hit ("a couple seconds" is a real round trip, not
      // a timeout). Now distinguishes them: a genuine fetch failure
      // (offline/DNS/timeout) still says to check the connection, but a
      // real server response — success OR the backend's own thrown error —
      // shows the ACTUAL reason instead of a guess. This also answers "this
      // should work offline anyway" honestly rather than silently: for a
      // stop that hasn't been submitted yet, there is no saved PDF to open
      // yet — this preview is generated by the backend's real Google Docs
      // code (see buildDeliveryPdfBlob_), which only runs server-side and
      // genuinely has no offline path; an ALREADY-SUBMITTED stop's real PDF
      // still opens fine offline-cached-by-the-browser or once back online,
      // same as before (see the fileId branch above, unchanged).
      showToast(
        result.offline
          ? "Couldn't reach the server to generate the invoice — check your connection and try again. (A not-yet-submitted stop's invoice preview needs a connection to generate; an already-submitted stop's saved invoice doesn't.)"
          : (result.error || "Couldn't generate the invoice.")
      );
      return;
    }
    // Not revoking the object URL after opening — the new tab needs it to
    // stay valid for as long as it's open/printing, and it's one PDF-sized
    // URL per tap, reclaimed automatically when that tab closes or the app
    // reloads. Same pattern the old on-device receipt used for its own
    // blob URL.
    const blobUrl = URL.createObjectURL(result.blob);
    const win = window.open(blobUrl, "_blank");
    if (!win) {
      showToast("Couldn't open the print preview — check that pop-ups are allowed for this site.");
    }
  } finally {
    printBtn.disabled = false;
    printBtn.textContent = originalLabel;
  }
}

// Builds the exact payload shape Code.gs's buildDeliveryPdfBlob_ (via
// either handleSubmitStop_ or handlePreviewPdf_) needs to render the
// delivery-confirmation document — shared by submitStop_ (the real submit)
// and printInvoice_ (a pre-submit preview print) so the two can never
// quietly drift apart into two different-looking documents, which is
// exactly the confusion G's "2 print buttons" complaint was about in the
// first place. hasSignatureOverride lets submitStop_ keep its own
// "Submit Without Signature" semantics (deliberately discards a drawn
// signature even if one exists — see its own comment) without baking that
// one-off rule into this shared builder; omitted, this reads the signature
// pad's current state as-is, which is what a plain print/preview wants.
function buildStopPdfPayload_(actionName, hasSignatureOverride) {
  if (!currentStop) return null;

  const hasSignature = hasSignatureOverride != null ? hasSignatureOverride : sigPad.hasStroke;
  const signatureImage = hasSignature ? document.getElementById("sig-pad").toDataURL("image/png") : null;
  const skipReasonSelect = document.getElementById("skip-sig-reason-select");
  const skipReason = skipReasonSelect ? skipReasonSelect.value : "";
  // Per G's "add option for driver to type in a different email to send the
  // final invoice to" — only meaningful for a real submit (handleSubmitStop_
  // passes it to sendDeliveryEmail_); handlePreviewPdf_ just ignores the
  // field, same as it already ignores anything else it doesn't need.
  const extraEmailInput = document.getElementById("extra-invoice-email-input");
  const extraInvoiceEmail = extraEmailInput ? extraEmailInput.value.trim() : "";

  const racksUnloaded = currentStop._racksUnloadedEntered;
  const exceptions = Object.values(flaggedItems).map((ex) => {
    // Same cap as the qty-affected input in renderExceptionForms_ — enforced
    // again here as a last line of defense so a submitted exception can
    // never claim more units were rejected/short/damaged than were ordered,
    // regardless of how qty_change got set.
    let qtyChange = Number(ex.qty_change);
    if (!isFinite(qtyChange) || qtyChange < 0) qtyChange = 0;
    if (qtyChange > ex.qty) qtyChange = ex.qty;
    return {
      item_code: ex.item_code,
      item_name: ex.item_name,
      size: ex.size || "",
      reason: exceptionReasonText_(ex), // folds in the Rejected-only sub-reason, e.g. "Rejected - Pests" — see exceptionReasonText_
      qty_change: qtyChange,
      notes: ex.notes,
    };
  });

  // Same shape Code.gs expects (see the added_items doc comment at the top
  // of Code.gs) — item_code/item_name/common_name/size carried straight
  // from the catalog entry the driver picked, qty/notes from what the
  // driver set on the Added Items list, unit_price/sub_total computed here
  // since the catalog doesn't know quantity.
  const addedItemsPayload = Object.values(addedItems).map((it) => {
    let qty = Number(it.qty);
    if (!isFinite(qty) || qty < 1) qty = 1;
    const unitPrice = it.unit_price != null ? Number(it.unit_price) : null;
    const subTotal = unitPrice != null ? Number((unitPrice * qty).toFixed(2)) : null;
    return {
      item_code: it.item_code || "",
      item_name: it.item_name || "",
      common_name: it.common_name || "",
      size: it.size || "",
      qty: qty,
      unit_price: unitPrice,
      sub_total: subTotal,
      notes: it.notes || "",
    };
  });
  const hasAddedItems = addedItemsPayload.length > 0;
  // Per G's "Affects the total" — folded in here, before this ever reaches
  // Code.gs, so buildDeliveryPdfBlob_ can just print body.total/body.subtotal
  // as given rather than recomputing them.
  const addedTotal = addedItemsSubtotal_(addedItems);
  const baseSubtotal = getStopSubtotal_(currentStop);
  const baseTotal = getStopTotal_(currentStop);
  const payloadSubtotal = hasAddedItems ? (baseSubtotal || 0) + addedTotal : baseSubtotal;
  const payloadTotal = hasAddedItems ? (baseTotal || 0) + addedTotal : baseTotal;

  // Everything below racks_unloaded is extra context so the backend can
  // build a proof-of-delivery PDF without a second lookup — the backend
  // only ever sees a Sheet, not the published route_plan.json file. Deliberately NOT
  // included: total_discrepancy_note / printed_subtotal_on_pdf — that's an
  // internal billing note about our own PDF export bug (see PROJECT-NOTES.md)
  // and must never end up on a document or email sent to the customer.
  return {
    action: actionName,
    date: manifest.dispatch_date,
    truck: currentStop.truck,
    stop_id: currentStop.stop_id,
    customer_name: currentStop.customer_name,
    customer_code: currentStop.customer_code || "",
    cart_number: currentStop.cart_number || "",
    address: currentStop.address || "",
    delivery_time: currentStop.delivery_time || "", // planned time, from the route plan — lets the backend log planned-vs-actual to the Route Timing sheet
    payment_terms: currentStop.payment_terms || "",
    order_note: currentStop.order_note || "", // shown in the PDF's "Order Notes" box — see buildDeliveryPdfBlob_ in Code.gs
    order_numbers: (currentStop.orders || []).map((o) => o.order_number),
    racks_expected: currentStop.racks_expected,
    racks_unloaded: racksUnloaded,
    // common_name/plant_form/barcode/unit_price/sub_total come from the
    // route plan's own ERP items-export lookup (see enrichLineItemsWithErpData_
    // in Code.gs) — carried straight through from what was loaded, not
    // looked up again here, so the backend PDF builder needs no second
    // lookup at submit/preview time. Any of these can be blank/null if that
    // item code wasn't in the export yet — the PDF just leaves that column blank.
    line_items: getLineItems_(currentStop).map((li) => ({
      qty: li.qty,
      item_code: li.item_code || "",
      item_name: li.item_name,
      size: li.size || "",
      common_name: li.common_name || "",
      plant_form: li.plant_form || "",
      barcode: li.barcode || "",
      unit_price: li.unit_price != null ? li.unit_price : null,
      sub_total: li.sub_total != null ? li.sub_total : null,
    })),
    subtotal: payloadSubtotal,
    delivery_fee: getStopDeliveryFee_(currentStop),
    total: payloadTotal,
    exceptions: exceptions,
    added_items: addedItemsPayload,
    signature_captured: hasSignature,
    signature_image: signatureImage,
    signature_skipped_reason: hasSignature ? "" : skipReason,
    rack_photo_image: rackPhotoDataUrl,
    contact_emails: currentStop.contact_emails || [],
    extra_invoice_email: extraInvoiceEmail,
    submitted_at_iso: new Date().toISOString(),
  };
}

// Same POST shape/timeout convention as sendToBackend_ below, but this one
// expects a raw PDF blob back instead of a JSON {ok:...} body — see
// handlePreviewPdf_ in Code.gs, which returns the PDF directly rather than
// wrapping it in the usual JSON envelope. A backend error still comes back
// as a normal 200 + JSON body in this app's existing convention (jsonOut_),
// so checking the response blob's type is how a real PDF is told apart
// from an error without needing a second response shape.
//
// Returns { blob, error, offline } — NOT just a bare blob-or-null (changed
// 2026-09-30, per G: "i clicked it, loaded couple seconds then said couldnt
// load invoice check you internet connection but im connected to fast
// internet"). Every failure used to collapse into a plain `null`, so
// printInvoice_'s toast always said "check your connection" even when the
// connection was fine and the SERVER had actually responded — with a
// success, or with its own real, specific error (handlePreviewPdf_'s
// try/catch in Code.gs sends back {ok:false, error: String(err)} on a
// genuine failure, e.g. inside buildDeliveryPdfBlob_) — either way a couple
// of real seconds, not a timeout. `offline: true` is set ONLY on an actual
// fetch failure (network unreachable, DNS, CORS, or this function's own 30s
// abort) — that's the one case that's genuinely a connectivity problem, so
// it's the only case whose message should say so; every other path returns
// the real reason from the server in `error` instead of guessing.
async function fetchPdfBlob_(payload) {
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf("PASTE_YOUR") === 0) {
    return { blob: null, error: "The app isn't configured with a backend URL yet.", offline: false };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const blob = await res.blob();
    if (blob.type && blob.type.indexOf("application/json") === 0) {
      // An {ok:false, error:...} envelope, not a PDF — read the real reason
      // out of it instead of discarding it. Checked BEFORE the res.ok check
      // below on purpose: handlePreviewPdf_'s own validation errors (e.g.
      // "missing field: customer_name") come back as a real non-2xx status
      // (jsonOut_(..., 400)) WITH a JSON body carrying the actual message —
      // checking res.ok first would catch that as a generic "HTTP 400" and
      // throw away the specific reason the backend already provided.
      let message = "The server couldn't generate the invoice.";
      try {
        const errBody = JSON.parse(await blob.text());
        if (errBody && errBody.error) message = String(errBody.error);
      } catch (parseErr) {
        // Body wasn't valid JSON after all — fall back to the generic message above.
      }
      return { blob: null, error: message, offline: false };
    }
    if (!res.ok) {
      return { blob: null, error: "The server returned an error (HTTP " + res.status + ") generating the invoice.", offline: false };
    }
    return { blob: blob, error: null, offline: false };
  } catch (err) {
    // The ONLY genuinely offline/connectivity case: fetch itself never got
    // a response (network unreachable, DNS failure, CORS, or the 30s abort
    // above).
    console.warn("pdf preview fetch failed", err);
    return { blob: null, error: null, offline: true };
  }
}

// Returns the backend's parsed response object on a genuine success
// (data.ok === true — carries pdf_file_id, used to let a driver print the
// delivery PDF later), or null on anything else (not configured, network
// failure, timeout, non-ok HTTP status, or the backend's own ok:false).
// Was a bare boolean before pdf_file_id needed to make it back to the
// caller too — callers just need `if (result)` where they used to check
// the boolean.
async function sendToBackend_(payload) {
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf("PASTE_YOUR") === 0) {
    return null; // not configured yet — treat as offline so nothing is silently lost
  }
  try {
    const controller = new AbortController();
    // A submit's backend work is a real Drive/Docs/Gmail chain (build the
    // PDF, save it, email it — see buildAndSavePdf_/sendDeliveryEmail_ in
    // Code.gs), which can genuinely take longer than a plain API call,
    // especially on a cold Apps Script start. 15s was cutting that off
    // early on a perfectly good connection — not a real "no signal" case,
    // just a slow one — which is exactly what queued it and left the
    // "waiting to sync" banner showing while on wifi the whole time.
    const timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      // text/plain avoids a CORS preflight that Apps Script Web Apps can't answer —
      // see the CORS note at the top of Code.gs. The body is still JSON text.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok ? data : null;
  } catch (err) {
    console.warn("submit failed, will queue offline", err);
    return null;
  }
}

// ==================================================================
// OFFLINE QUEUE
// ==================================================================
// Every submit now runs through this queue, not just genuine no-signal ones
// (see submitStop_) — so flushOfflineQueue_ can get kicked off far more
// often, and from more places at once (a submit, the online event, the 30s
// interval, visibilitychange). flushInProgress_ stops two passes from
// actually SENDING at the same time (see below), and _queue_id (assigned in
// queueOffline_) is what lets a pass remove only the specific items it
// confirmed sent when it writes back — never the whole queue array it
// started with — which matters a lot now: with every submit going through
// here, it's routine for a second stop to get queued while the first one's
// pass is still awaiting the backend, and that second item must not get
// wiped out when the first pass finishes and writes back. (This exact
// clobber is what earlier testing on this change caught: item B queued
// mid-flush was silently lost because the in-flight pass wrote back an
// empty "remaining" list computed from its own stale snapshot rather than
// the queue's current contents.) queuedDuringFlush_ additionally triggers
// one extra pass right after the current one finishes, so a stop queued
// mid-flush doesn't sit waiting for the next 30s interval — but a pass that
// fails never retriggers itself, so a genuine outage doesn't spin.
//
// This care matters beyond just tidiness: the email side is already
// careful to never double-send to a real customer (see the
// sendDeliveryEmail_ rule in PROJECT-NOTES.md), and a queue bug that sent
// the same stop to the backend twice would risk exactly that.
let flushInProgress_ = false;
let queuedDuringFlush_ = false;
let queueIdCounter_ = 0;

function queueOffline_(payload) {
  if (!payload._queue_id) {
    queueIdCounter_ += 1;
    payload._queue_id = Date.now() + "-" + queueIdCounter_;
  }
  const queue = readQueue_();
  queue.push(payload);
  writeQueue_(queue);
  updateQueueBanner_();
  if (flushInProgress_) queuedDuringFlush_ = true;
}

function readQueue_() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_QUEUE) || "[]");
  } catch (err) {
    return [];
  }
}
function writeQueue_(queue) {
  try {
    localStorage.setItem(STORAGE_KEY_QUEUE, JSON.stringify(queue));
  } catch (err) {
    console.warn("could not persist offline queue", err);
  }
  mirrorQueueToNative_(queue);
}

async function flushOfflineQueue_() {
  if (flushInProgress_) return; // a pass is already running — see the note above queueOffline_
  flushInProgress_ = true;
  try {
    const queue = readQueue_();
    if (queue.length === 0) {
      updateQueueBanner_();
      return;
    }
    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf("PASTE_YOUR") === 0) return;

    const sentIds = new Set();
    let anyPdfSynced = false;
    for (const payload of queue) {
      // _queue_id is purely a local bookkeeping field — strip it before it
      // goes over the wire so the backend only ever sees the fields it
      // already expects.
      const { _queue_id, ...toSend } = payload;
      const result = await sendToBackend_(toSend);
      if (!result) continue;
      sentIds.add(_queue_id);
      // Same as the online-submit path in submitStop_ — a queued delivery
      // only gets its PDF built once it actually reaches the backend, so
      // the print button only becomes available here, on sync.
      if (result.pdf_file_id) {
        // customer_code, not stop_id — see stopKey_'s comment. Falls back to
        // stop_id for a payload queued before this existed / the rare stop
        // with no customer_code, same as stopKey_ itself does.
        mergeDriverStateLocal_(payload.customer_code || payload.stop_id, { pdf_file_id: result.pdf_file_id });
        anyPdfSynced = true;
      }
    }
    // Re-read the queue fresh rather than trusting the snapshot taken at the
    // top of this pass — something may have been queued (or even, in
    // principle, cleared) while the loop above was awaiting the network —
    // and remove only the items this pass actually confirmed sent.
    if (sentIds.size > 0) {
      const current = readQueue_();
      writeQueue_(current.filter((p) => !sentIds.has(p._queue_id)));
    }
    if (anyPdfSynced) applyStoredDriverState_();
    updateQueueBanner_();
    if (sentIds.size > 0) {
      // "item(s)" rather than "delivery/deliveries" — the queue can also
      // hold a start_route payload (see startRoute_) alongside stop submits.
      showToast(sentIds.size + " queued item(s) synced.");
    }
  } finally {
    flushInProgress_ = false;
    if (queuedDuringFlush_) {
      queuedDuringFlush_ = false;
      flushOfflineQueue_();
    }
  }
}

function updateQueueBanner_() {
  const banner = document.getElementById("queue-banner");
  const count = readQueue_().length;
  if (count === 0) {
    banner.classList.add("hidden");
    banner.textContent = "";
  } else {
    banner.classList.remove("hidden");
    banner.textContent = count + " delivery" + (count === 1 ? "" : "ies") + " waiting to sync — will send automatically when back online.";
  }
}

// ==================================================================
// NATIVE BACKGROUND SYNC (iOS app only)
// ==================================================================
// The offline queue above only ever flushes while THIS PAGE is open and
// running — a submit, the "online" event, the 30s interval, or
// visibilitychange. That's a hard ceiling on the plain web/PWA build: iOS
// Safari gives a web page no way to run JS while the app is fully closed,
// not backgrounded. The native iOS app (capacitor-app/) closes that gap
// with real native code instead — a Swift BGTaskScheduler background task
// (see capacitor-app/ios/App/App/AppDelegate.swift) that iOS runs
// opportunistically while the app isn't even open. That native code can't
// see this page's localStorage at all, so the three functions below are
// the JS-side half of the bridge, via the Capacitor Preferences plugin
// (iOS: backed by UserDefaults, readable from native Swift; plain web/PWA:
// falls back to a differently-prefixed localStorage key — harmless, and
// never actually populated with anything there since no native task ever
// runs to write to it).
//
//   mirrorQueueToNative_        — every queue write (writeQueue_) is also
//                                  mirrored here, so the native task always
//                                  sees what's currently pending.
//   mirrorAppsScriptUrlToNative_ — written once at startup, so the native
//                                  task POSTs to whatever backend URL is
//                                  actually configured in THIS file, not a
//                                  separately hardcoded Swift copy that
//                                  could silently drift out of sync.
//   reconcileNativeBackgroundSyncs_ — the other direction: after the native
//                                  task sends a queued item, it can't
//                                  update THIS page's in-memory/localStorage
//                                  state either (the page may not even be
//                                  loaded while it runs) — so it records
//                                  what it sent to STORAGE_KEY_NATIVE_SYNCED
//                                  instead, and this function folds that
//                                  into local state (removes the item from
//                                  the queue, merges pdf_file_id the same
//                                  way flushOfflineQueue_'s own success path
//                                  does) the next time the app is actually
//                                  open to run it — called once at startup
//                                  and again on every visibilitychange back
//                                  to visible (see init()/wireLoginScreen's
//                                  caller above), so a driver reopening the
//                                  app sees an up-to-date queue/route list
//                                  whether a stop synced while they were
//                                  looking at the app or while it was
//                                  closed in their pocket.
function nativePreferences_() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences) || null;
}

function mirrorQueueToNative_(queue) {
  const prefs = nativePreferences_();
  if (!prefs) return;
  prefs.set({ key: STORAGE_KEY_NATIVE_QUEUE_MIRROR, value: JSON.stringify(queue) }).catch((err) => {
    console.warn("could not mirror offline queue to native storage", err);
  });
}

function mirrorAppsScriptUrlToNative_() {
  const prefs = nativePreferences_();
  if (!prefs) return;
  prefs.set({ key: STORAGE_KEY_NATIVE_APPS_SCRIPT_URL, value: APPS_SCRIPT_URL }).catch((err) => {
    console.warn("could not mirror APPS_SCRIPT_URL to native storage", err);
  });
}

async function reconcileNativeBackgroundSyncs_() {
  const prefs = nativePreferences_();
  if (!prefs) return; // plain web/PWA build — nothing to reconcile, ever

  let entries;
  try {
    const res = await prefs.get({ key: STORAGE_KEY_NATIVE_SYNCED });
    entries = JSON.parse(res.value || "[]");
  } catch (err) {
    return;
  }
  if (!Array.isArray(entries) || entries.length === 0) return;

  // Clear the native record FIRST, before touching any local state. If
  // this page reloads mid-reconcile, the worst case is one queue item's
  // local status is a beat late (corrected by the next flush/reload) —
  // safer than risking this list getting processed twice, which for a
  // submit_stop payload would mean risking a second email to a real
  // customer (see the sendDeliveryEmail_ rule in PROJECT-NOTES.md).
  try {
    await prefs.set({ key: STORAGE_KEY_NATIVE_SYNCED, value: "[]" });
  } catch (err) {
    return;
  }

  const sentIds = new Set(entries.map((e) => e._queue_id));
  const current = readQueue_();
  writeQueue_(current.filter((p) => !sentIds.has(p._queue_id)));

  let anyPdfSynced = false;
  entries.forEach((e) => {
    // customer_code, not stop_id — see stopKey_'s comment. AppDelegate.swift
    // echoes customer_code back from the queued payload alongside stop_id
    // (see its own comment) so this stays keyed the same way the web-side
    // queue flush above is.
    const key = e.customer_code || e.stop_id;
    if (key && e.pdf_file_id) {
      mergeDriverStateLocal_(key, { pdf_file_id: e.pdf_file_id });
      anyPdfSynced = true;
    }
  });
  if (anyPdfSynced) applyStoredDriverState_();
  updateQueueBanner_();
  showToast(entries.length + " queued item(s) synced while the app was closed.");
}

// ==================================================================
// OFFLINE-FIRST: route plan data cache + service worker registration
// ==================================================================
// Saves the just-fetched route plan/pins as the offline fallback. Called
// only after a successful fetch (see init()) — never write a failed or
// partial load in here.
function saveRoutePlanCache_(manifestToCache, pinsToCache) {
  try {
    localStorage.setItem(STORAGE_KEY_ROUTE_PLAN_CACHE, JSON.stringify({ manifest: manifestToCache, pins: pinsToCache }));
  } catch (err) {
    console.warn("could not persist route plan cache", err);
  }
}

// Returns the last cached {manifest, pins}, or null if none saved yet
// (e.g. very first load ever, before any successful fetch happened).
function loadRoutePlanCache_() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ROUTE_PLAN_CACHE);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

// Registers service-worker.js, which caches the app shell (this file,
// style.css, index.html, pins.json) so the page itself still loads with
// zero signal, not just the route plan data (that part is the
// localStorage cache above — the service worker deliberately never
// caches the get_route_plan fetch, since that has to stay live/fresh).
// Feature-detected and non-fatal: an iPad on an old iOS version, or any
// browser without service worker support, just falls back to today's
// behavior (page load itself needs signal) with no error shown — this
// is a progressive enhancement, not a requirement to use the app.
function registerServiceWorker_() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("service-worker.js").catch((err) => {
    console.warn("service worker registration failed", err);
  });
}

// ==================================================================
// LOCAL DRIVER-STATE PERSISTENCE
// (This is a static-file frontend with no GET-back from the backend,
// so completed-stop status has to survive a reload locally. The
// Sheet stays the source of truth for the office; this is just what
// paints the route-list pills on this device.)
//
// Keyed by stopKey_(stop) (customer_code, falling back to stop_id — see
// that function's own comment), NOT stop_id directly, as of 2026-09-29 —
// stop_id ("T4-1"-style) is recomputed on every live route-plan refresh
// whenever a stop's truck or delivery time changes (see
// refreshRoutePlanLive_/buildLiveRouteStops_), so keying this by stop_id
// would risk a stop that already synced showing as "not yet submitted"
// again after a live refresh — worst case, a second email to a real
// customer on a second submit (see the sendDeliveryEmail_ rule in
// PROJECT-NOTES.md). Callers pass a raw key string (usually
// stopKey_(currentStop), or payload.customer_code || payload.stop_id for a
// queued/native-synced payload that only carries plain fields, not a stop
// object) rather than a stop object, so this file stays intentionally naive
// about what the key actually is.
// ==================================================================
function saveDriverStateLocal_(key, state) {
  const all = readDriverStateStore_();
  all[key] = state;
  try {
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(all));
  } catch (err) {
    console.warn("could not persist driver state", err);
  }
}

// Patches a few fields onto a stop's already-saved state instead of
// replacing the whole record the way saveDriverStateLocal_ does — used for
// pdf_file_id, which only becomes known sometime after the full
// racks/exceptions/signature state was already saved (immediately on
// submit for an online delivery, or later on offline-queue sync), and must
// not clobber it.
function mergeDriverStateLocal_(key, patch) {
  const all = readDriverStateStore_();
  all[key] = Object.assign({}, all[key], patch);
  try {
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(all));
  } catch (err) {
    console.warn("could not persist driver state", err);
  }
}
function readDriverStateStore_() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_STATE) || "{}");
  } catch (err) {
    return {};
  }
}
function applyStoredDriverState_() {
  const stored = readDriverStateStore_();
  manifest.stops.forEach((stop) => {
    const key = stopKey_(stop);
    if (stored[key]) {
      stop.driver_state = Object.assign({}, stop.driver_state, stored[key]);
    }
  });
}

// ==================================================================
// HELPERS
// ==================================================================
function showScreen_(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function formatDispatchDate_(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
