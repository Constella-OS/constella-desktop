export const WINDOW_SHORTCUT = 'Control+Alt+C';
export const IS_DEV_ENV = process.env.NODE_ENV === 'development';

// Dev toggle: flip to true to point desktop at a local Python backend on port 8000.
// Must stay false for normal dev/prod — all API calls go to fastfind.app otherwise.
export const USE_LOCAL_BACKEND = true;

export const BACKEND_URL = USE_LOCAL_BACKEND
  ? // 127.0.0.1, NOT localhost: uvicorn binds IPv4-only, but `localhost`
    // resolves to ::1 (IPv6) first and the main-process http stack doesn't
    // fall back to IPv4 — every call got ECONNREFUSED ::1:8000 (surfacing as a
    // blank-message axios error). Pinning IPv4 sidesteps the resolution detour.
    'http://127.0.0.1:8000/'
  : 'https://fastfind.app/'; // DO NOT CHANGE HEROKU APP NAME OR TRANSFER THE PROJECT AROUND

// One-shot startup log so you can confirm which backend each process is
// pointing at (main + renderer both import this).
console.log('[constants] BACKEND_URL =', BACKEND_URL);

// Staging: https://constella-external-api-653702ba9b9b.herokuapp.com/

// for the one that has the sharing view support
export const WEB_APP_URL = true
  ? 'https://web.constella.app'
  : 'http://localhost:3000';

export const LANDING_PAGE_URL = true
  ? 'https://constella.app'
  : 'http://localhost:3000';

// Vite web build deployed at the.constella.app. Dev flips to localhost:5173.
export const USE_APP_URL = true
  ? 'https://the.constella.app'
  : 'http://localhost:5173';

export const INSTANT_SYNCING_URL = USE_LOCAL_BACKEND
  ? 'http://127.0.0.1:8000/'
  : 'https://instant-syncing-server.onrender.com/';

// On the win branch, the brackets will be \\\\ instead
export const LOCAL_FILE_PROTOCOL = 'constella-file-protocol://';
export const LOCAL_FILE_PROTOCOL_OTHER = 'constella-file-protocol:\\\\';
export const LOCAL_FILE_PROTOCOL_JUST_NAME = 'constella-file-protocol';

// when want to log even in dev environment
export const IS_OVERRIDE_ANALYTICS = false;

// for screen recording, use fixed background
export const IS_SCREEN_RECORDING = false;

// Dev/QA toggle: when true, onboarding-v2 auto-launches on every logged-in
// mount of HomeUI so we can keep iterating without resetting the `firstTime`
// storage flag (which would re-route through the auth handoff). Centralized
// here because flipping it to true in a release build would force every
// authed user back through onboarding — must be `false` on main.
export const FORCE_SHOW_ONBOARDING_V2 = false;

// Crisp chat website ID. The chatbox is only mounted on DashboardHome (see
// src/utils/crisp.ts). Leave empty to disable Crisp entirely.
export const CRISP_WEBSITE_ID = '0a08af34-340d-4888-82fc-c33e1818ae6d';

const MAC_DRAG_BAR_WIDTH = 0.5;
const MAC_SEARCH_BAR_WIDTH = 12.2;
export const SMALL_SCREEN_SEARCHBAR_HEIGHT = 10;

const WINDOWS_DRAG_BAR_WIDTH = 2.5;
const WINDOWS_SEARCH_BAR_WIDTH = 7;

export const OS = 'MAC';

export const DISPLAY_CONSTANTS = {
  MIN_ZOOM: 0.1,
  MAX_ZOOM: 2.5,
  MAX_DISPLAYED_EDGES: 25,
};

export const DIMENSIONS = {
  MAC: {
    DRAG_BAR: MAC_DRAG_BAR_WIDTH,
    SEARCH_BAR: MAC_SEARCH_BAR_WIDTH,
    FLOW_VIEW: 100,
    FLOW_VIEW_CLOSED: (100 - MAC_DRAG_BAR_WIDTH - MAC_SEARCH_BAR_WIDTH) / 2,
  },
  WINDOWS: {
    DRAG_BAR: WINDOWS_DRAG_BAR_WIDTH,
    SEARCH_BAR: WINDOWS_SEARCH_BAR_WIDTH,
    FLOW_VIEW: 100 - WINDOWS_DRAG_BAR_WIDTH - WINDOWS_SEARCH_BAR_WIDTH,
    FLOW_VIEW_CLOSED:
      (100 - WINDOWS_DRAG_BAR_WIDTH - WINDOWS_SEARCH_BAR_WIDTH) / 2,
  },
};

export const VAULT_VERSION = '0.1.5';

// about the max number of embeddings that come from a single file
export const ESTIMATED_MAX_FILE_EMBEDDINGS = 50;

// for electron-store
export const STORE_KEYS = {
  SHORTCUTS: {
    quickOpenConstella: '--main-quickOpenConstella',
    // Global hotkey that toggles the quick-capture overlay window. Configurable
    // from Settings → Shortcuts and read on boot when registering the shortcut.
    showSearchOverlay: '--main-showSearchOverlay',
  },
  GENERAL: {
    hasSetLoginItem: 'hasSetLoginItem',
  },
};

export const SUPPORTED_LOCALES = ['en', 'ja', 'de', 'fr', 'es'];

// Electron accelerator tokens that are modifiers only (no glyph). A registrable
// accelerator needs at least one real key on top of these.
const ACCELERATOR_MODIFIER_TOKENS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta',
]);

// True only when `accelerator` has a real (non-modifier) key, e.g.
// "Command+Shift+O". A half-finished rebind can persist a modifier-only value
// ("Command+Shift", or "Meta+Shift"); globalShortcut.register() THROWS on those,
// so the boot registration would otherwise leave the user with no working
// shortcut. Callers use this to fall back to the default instead.
export const hasRealKey = (accelerator: string | undefined | null): boolean => {
  if (!accelerator) return false;
  return accelerator
    .split('+')
    .map((token) => token.trim().toLowerCase())
    .some(
      (token) => token.length > 0 && !ACCELERATOR_MODIFIER_TOKENS.has(token),
    );
};
