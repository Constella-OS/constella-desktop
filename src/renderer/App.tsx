import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import AuthPage from '../components/auth/AuthPage';
import IntegrationConnectPage from '../components/integrations/IntegrationConnectPage';
import WebUpgradePage from '../components/subscriptions/WebUpgradePage';
import CheckoutSuccessPage from '../components/subscriptions/CheckoutSuccessPage';
import PaywallPage from '../components/subscriptions/PaywallPage';
import SubscriptionUpgradeSuccessListener from '../components/subscriptions/SubscriptionUpgradeSuccessListener';
import posthog from 'posthog-js';
import mixpanel from 'mixpanel-browser';
import { Worker } from '@react-pdf-viewer/core';

// **** GLOBAL CSS IMPORTS ****
import 'react-tooltip/dist/react-tooltip.css';
import 'react-sliding-pane/dist/react-sliding-pane.css';
import 'react-datepicker/dist/react-datepicker.css';
import './styles/fixed-styles.css'; // as variables here so make it come first
import './styles/fonts.css';
import './styles/App.css';
import './styles/editor.css';
import './styles/components.css';
import './styles/stella.css';
import './styles/jarvis.css'; // Jarvis HUD theme — gated on html.jarvis, loads after the surfaces it re-skins
import 'tippy.js/dist/tippy.css';
import 'react-contexify/ReactContexify.css';
// Import the styles
import '@react-pdf-viewer/core/lib/styles/index.css';
import '@react-pdf-viewer/default-layout/lib/styles/index.css';
import 'katex/dist/katex.min.css';

import 'regenerator-runtime/runtime'; // need this for async/await

// i18n init — side-effect import registers i18next resources + React provider so any
// shared component can call useTranslation() at first render. Locale auto-detection
// runs in an effect below (needs the platform adapter to already be set).
import { detectAndApplyLanguage } from '../i18n';

import { ReactNode, useEffect, useState } from 'react';
import SearchWindow from '../components/windows/SearchUI';
import CanvasView from '../components/windows/CanvasView';
import DashboardHome from '../components/windows/DashboardHome';
import HomeDiscoverySplit from '../components/windows/HomeDiscoverySplit';
import useAppViewStore from '../utils/stores/ui/AppViewStore';
import ConstellaOnboardingFlow from '../components/onboarding_v2/constella/ConstellaOnboardingFlow';
import IndexingProgressModal from '../components/onboarding_v2/IndexingProgressModal';
import AutoBuildingJoyride from '../components/onboarding_v2/AutoBuildingJoyride';
import HomeWalkthroughJoyride from '../components/onboarding_v2/HomeWalkthroughJoyride';
import UltraPaywallModal from '../components/subscriptions/UltraPaywallModal';
import CancellationRetentionModal from '../components/subscriptions/CancellationRetentionModal';
import useInitialProjectFlowStore from '../utils/stores/ui/InitialProjectFlowStore';
import useOnboardingV2Store from '../utils/stores/ui/OnboardingV2Store';
import { useUserStore } from '../utils/stores/UserStore';
// RxDB plugin registration moved inside a one-shot module side effect guarded by a
// try/catch. The call is safe on desktop (real rxdb) and harmless on web (stubbed db
// layer never actually uses the plugin), but keeping it bare at module top meant a
// partial init error would crash the whole app before any UI rendered.
import { addRxPlugin } from 'rxdb';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';
try {
  addRxPlugin(RxDBQueryBuilderPlugin);
} catch (e) {
  console.warn('[App] addRxPlugin failed (likely harmless on web):', e);
}

import { ReactFlowProvider } from '@xyflow/react';

import toast, { Toaster } from 'react-hot-toast';
import {
  exportNotesToMarkdown,
  exportNotesToMarkdownWithWorker,
} from '../utils/settings/renderer-settings';
import { SettingsProvider } from '../utils/contexts/SettingsContext';
import { IS_DEV_ENV, IS_OVERRIDE_ANALYTICS } from '../main/constants';
import packageJson from '../../package.json';
import { useSettingsStore } from '../utils/stores/SettingsStore';
import { LOCAL_STORAGE_KEYS } from '../utils/local-storage';
import { getPlatform } from '../platform/platformInstance';
import { usePlatform } from '../platform/usePlatform';
import { trackEvent } from '../utils/analytics';
import { initializeVectorDB, createVectorDBIndex } from '../db/astro-wrapper';
// Sentry init was moved to the Electron-specific bootstrap (src/renderer/
// bootstrap-electron.ts) so the shared renderer can build under Vite without pulling
// @sentry/electron/renderer — that package's module-load code references Electron APIs
// that don't exist in a browser.
import {
  DEFAULT_TOAST_STYLE,
  showSuccessToast,
  TOAST_ICON_THEME,
} from '../utils/misc/toasting';
import SearchOverlayWindow from '../components/windows/SearchOverlayUI';
import ConnectAccountModal from '../components/settings/syncing/ConnectAccountModal';
import UnifiedCapture from '../components/capture/UnifiedCapture';
import { mirrorUserContextToMain } from '../utils/onboarding_v2/userContext';

const workerURL = new URL(
  '../utils/workers/pdf.worker.min.js',
  import.meta.url,
).toString();

// Route container for the main window. Reads `view` from the URL for the
// secondary windows (search, search-overlay) and otherwise picks between the
// new DashboardHome landing surface and the CanvasView (former HomeUI) based
// on the AppViewStore mode. Switching between dashboard ↔ canvas is in-place
// so heavy CanvasView state only mounts once the user starts a project.
const MainView = () => {
  const mode = useAppViewStore((s) => s.mode);
  // Canvases entered from the home ask box mount the chat+canvas split surface
  // instead of the standard CanvasView (see HomeDiscoverySplit / AppViewStore).
  const splitDiscovery = useAppViewStore(
    (s) => s.projectSeed?.splitDiscovery ?? false,
  );
  // First-run trigger: AuthPage hard-replaces to `/` after auth, wiping any
  // in-memory startOnboardingV2 call. We pick up the persistent flag here so
  // the onboarding fires whether the user lands on the dashboard or canvas.
  // OnboardingV2Store.finish() clears the flag so this won't re-fire.
  const isLoggedIn = useUserStore((s) => s.isLoggedIn);
  const startOnboardingV2 = useOnboardingV2Store((s) => s.start);
  // Web-only auth gate. The same gate used to live in CanvasView, but
  // DashboardHome is now the landing surface (CanvasView only mounts after the
  // user enters a project), so without this redirect a logged-out web user
  // sees the dashboard instead of /auth. Keys off USER_ID in storage to match
  // AuthPage's redirect-back gate (firebaseAuth can hold a persisted user past
  // an in-app logout that clears localStorage; using it here would cause an
  // infinite /auth ↔ / bounce). storage.get is sync on web, so we redirect on
  // first render with no flicker. Desktop has capabilities.deepLinks === true
  // so this branch never fires there.
  const isWeb = !getPlatform().capabilities.deepLinks;
  useEffect(() => {
    if (!isWeb) return;
    if (isLoggedIn) return;
    const storedUserId = getPlatform().storage.get(
      LOCAL_STORAGE_KEYS.SETTINGS.AUTH.USER_ID,
    );
    if (storedUserId) return;
    window.location.replace('/auth');
  }, [isWeb, isLoggedIn]);

  // Re-push the onboarding user-context (role + persona) into the main process
  // on every boot. The main cache also hydrates from electron-store, but this
  // covers users who onboarded before the mirror existed and keeps the two in
  // sync after a persona edit. Cheap + idempotent (reads localStorage only).
  useEffect(() => {
    mirrorUserContextToMain();
  }, []);

  // Desktop-only auth gate. Used to live inside CanvasView (which fired
  // ConnectAccountModal on first launch when `firstTime === null`), but
  // CanvasView no longer mounts on app launch — DashboardHome does. So a
  // brand-new install or any logged-out desktop user could land on the empty
  // dashboard with no path to sign in. Open the modal here whenever there is
  // no logical session: no UserStore login AND no persisted USER_ID. The
  // modal owns the desktop OAuth-website + deep-link handoff flow. Web takes
  // the redirect branch above and never reaches this effect.
  const setIsConnectAccountModalOpen = useSettingsStore(
    (s) => s.setIsConnectAccountModalOpen,
  );
  useEffect(() => {
    if (isWeb) return;
    if (isLoggedIn) return;
    const storedUserId = getPlatform().storage.get(
      LOCAL_STORAGE_KEYS.SETTINGS.AUTH.USER_ID,
    );
    if (storedUserId) return;
    setIsConnectAccountModalOpen(true);
  }, [isWeb, isLoggedIn, setIsConnectAccountModalOpen]);

  // pendingOnboardingV2 trigger. Paywall gating has been removed — every new
  // user goes straight into onboarding (and then the app) without waiting on
  // subscription state. subscriptionData is still kept as a dependency so the
  // effect re-runs if any auth-adjacent state changes mid-mount.
  const subscriptionData = useUserStore((s) => s.subscriptionData);
  useEffect(() => {
    if (
      !isLoggedIn ||
      getPlatform().storage.get('pendingOnboardingV2') !== 'true'
    ) {
      return;
    }
    // Guard against re-entering an already-running session. Without this guard
    // every `subscriptionData` change (refreshCredits spread, paywall poll,
    // periodic auth refresh) would re-call start(), minting a new sessionId
    // and snapping the controller back to the first question. That cycle can
    // become a render loop because controller effects fire setStage as part of
    // the reset.
    if (useOnboardingV2Store.getState().active) return;
    startOnboardingV2({ entrySource: 'first_time_auth' });
  }, [isLoggedIn, startOnboardingV2, subscriptionData]);

  // Paywall-first gating has been removed: every signed-in user goes straight
  // to the app. The /paywall route is still mounted so users who reach it via
  // a direct link (Settings → upgrade, expired trial, etc.) can still convert,
  // but nothing here forces the redirect after signup. Backend grants a
  // 14-day trial automatically so credits don't run out during the trial.

  // While the redirect to /auth is in flight, render nothing so the dashboard
  // doesn't flash for logged-out users. Synchronous storage check matches the
  // effect above so the early-return and the redirect agree.
  if (isWeb && !isLoggedIn) {
    const storedUserId = getPlatform().storage.get(
      LOCAL_STORAGE_KEYS.SETTINGS.AUTH.USER_ID,
    );
    if (!storedUserId) return null;
  }

  return (
    <>
      {/* New first-run onboarding (Constella — Onboarding Flow). Mounted at the
          route level so it survives the dashboard ↔ canvas mode flip; it reuses
          the same pendingOnboardingV2 trigger + OnboardingV2Store lifecycle the
          old controller used. */}
      <ConstellaOnboardingFlow />
      {/* Building memory / Indexing your data… modal — singleton driven by
          InitialProjectFlowStore so it survives NewCanvasModal closing
          and the dashboard → canvas mode flip. */}
      <IndexingProgressModalHost />
      {/* Auto-Building joyride — fires once the mindmap SSE stream emits
          `done` on a first-run flow. Self-hides via TutorialStore.variant. */}
      <AutoBuildingJoyride />
      {/* Home walkthrough joyride — fires 20s after the AutoBuilding
          joyride finishes, walks through Capture / Search / Help on the
          dashboard. */}
      <HomeWalkthroughJoyride />
      {/* Ultra paywall — opened by non-onboarding gates (free-tier node cap,
          post-AI-run upsell). Singleton driven by UltraPaywallStore. */}
      <UltraPaywallModal />
      {/* In-app cancellation + retention flow — opened from Settings →
          Account → Manage Subscription. Replaces the old "open Stripe billing
          portal" path so we can run a 2-weeks-free save attempt before the
          user actually cancels. Singleton driven by CancellationRetentionStore. */}
      <CancellationRetentionModal />
      {/* Connect-Account modal lives at the route level (not inside
          CanvasView) so it can open over DashboardHome too. CanvasView used
          to be the only landing surface, but DashboardHome now is — without
          this lift, an unauthed desktop user lands on an empty dashboard
          with no path to sign in. The modal owns the desktop OAuth-website
          + deep-link handoff flow. */}
      <ConnectAccountModal locale="en" />
      {/* Listens for the upgrade-success deep link the web /success page fires
          after Stripe checkout, then polls the subscription endpoint up to 3
          times so a slightly-late webhook still flips the user to active. */}
      {!isWeb && <SubscriptionUpgradeSuccessListener />}
      {mode === 'canvas' ? (
        splitDiscovery ? (
          <HomeDiscoverySplit />
        ) : (
          <CanvasView />
        )
      ) : (
        <DashboardHome />
      )}
    </>
  );
};

// Wires InitialProjectFlowStore → IndexingProgressModal. Inline so the host
// component only subscribes to the slices it actually renders.
const IndexingProgressModalHost = () => {
  const phase = useInitialProjectFlowStore((s) => s.phase);
  const progress = useInitialProjectFlowStore((s) => s.modalProgress);
  const status = useInitialProjectFlowStore((s) => s.modalStatus);
  return (
    <IndexingProgressModal
      isOpen={phase === 'indexing-modal'}
      progress={progress}
      status={status}
    />
  );
};

const getView = (): ReactNode => {
  // get query parameters
  const urlParams = new URLSearchParams(window.location.search);

  // get the view parameter
  const view = urlParams.get('view');

  // if the view is search, return the search window
  if (view === 'search') {
    return <SearchWindow />;
  } else if (view === 'search-overlay') {
    return <SearchOverlayWindow />;
  } else {
    return <MainView />;
  }
};

export default function App() {
  const platform = usePlatform();
  const [isClosingWindow, setIsClosingWindow] = useState(false);

  const { startSyncing } = useSettingsStore();

  // On first mount, resolve the user's preferred language (storage override → OS/browser
  // locale → English fallback) and swap i18next's active language. Safe to call repeatedly
  // — the module memoizes the detection promise.
  useEffect(() => {
    void detectAndApplyLanguage();
  }, []);

  // create embedding here to load the model in and kickstart the process
  useEffect(() => {
    if (window?.electron?.ipcRenderer) {
      window.electron.ipcRenderer
        .invoke('embed-text', {
          text: 'this is a test text',
        })
        .catch((err) => {
          console.error('[Embed:Renderer] Warm-up embed failed:', err);
        });
    }
  }, []);

  // Initialize the local vector store (LanceDB) on boot. This lives in the main
  // process but is renderer-triggered via IPC, so without this call nothing ever
  // opens the table — local file-index writes + recall queries then log
  // "LanceDB not initialized" and silently no-op. (The call used to live in the
  // old App boot effect; it was dropped during the onboarding refactor 7b518fa2.)
  // Fire-and-forget + idempotent: initLanceDB returns early if already open.
  useEffect(() => {
    if (!window?.electron?.ipcRenderer) return;
    initializeVectorDB()
      .then((res) => {
        // Past ~200k vectors LanceDB needs an ANN index or search falls back to
        // a brute-force scan. initLanceDB flags this; createIndexIfNeeded is
        // idempotent (skips if an index already exists). This wiring also lived
        // in the old boot effect dropped by 7b518fa2.
        if (res?.needsIndex) {
          createVectorDBIndex().catch((err) => {
            console.error('[LanceDB] index creation failed:', err);
          });
        }
      })
      .catch((err) => {
        console.error('[LanceDB] init failed:', err);
      });
  }, []);

  // AI Pipeline self-test (dev only). Runs once a few seconds after boot — i.e.
  // after stores, platform, IPC and LanceDB are all up — to prove the pipeline
  // engine + pure building blocks are wired correctly and (best-effort) that a
  // live `retrieve` reaches local + cloud. Dynamically imported so it never
  // ships in the web/prod bundle. See src/utils/ai-pipeline/selftest.ts.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (!window?.electron?.ipcRenderer) return;
    const t = setTimeout(() => {
      import('../utils/ai-pipeline/selftest')
        .then((m) => m.runAiPipelineSelfTest())
        .catch((err) => console.error('[ai-pipeline self-test] load failed:', err));
    }, 4000);
    return () => clearTimeout(t);
  }, []);

  // event listeners from main thread
  useEffect(() => {
    // listen for new Constella version update available and show toast if update
    window.electron.ipcRenderer.on('update-available', (updateInfo) => {
      toast(
        <div className="flex-col flex h-fit">
          <p>
            Downloading the update and shutting down the app in 1 minute. <br />{' '}
            <br />
            Do open the app again if it doesn't automatically in a few minutes.
          </p>{' '}
          <br /> <br />
          <p>
            <b>Release Notes:</b> {updateInfo.releaseNotes}
          </p>
        </div>,
        {
          duration: 10000,
        },
      );
      try {
        exportNotesToMarkdown();
      } catch (e) {
        console.log('Error exporting notes', e);
      }
    });

    // listen for download progress
    try {
      window.electron.ipcRenderer.on('show-update-message', (data) => {
        toast.remove();
        toast(data.message, {
          duration: data?.duration ?? 7000,
        });
      });
    } catch (e) {
      console.log('Error setting up download progress listener', e);
    }

    // On window focus, start syncing
    window.electron.ipcRenderer.on('browser-window-focus', () => {
      startSyncing();
    });

    // listen for closing window
    window.electron.ipcRenderer.on('closing-window', () => {
      toast('Cleaning up and closing window...', { duration: 5500 });
      setIsClosingWindow(true);
    });
  }, []);

  // set settings CSS variables from local storage on load
  useEffect(() => {
    // font size general
    const fontSize = getPlatform().storage.get('--html-font-size') || '14px';
    document.documentElement.style.setProperty(`--html-font-size`, fontSize);

    // editor font size scale
    const editorFontSize =
      getPlatform().storage.get('--editor-font-size') || '1.0';
    document.documentElement.style.setProperty(
      `--editor-font-size`,
      editorFontSize,
    );

    // font family
    const fontFamily =
      getPlatform().storage.get('--font-family') ||
      'Avenir Next, system-ui, -apple-system, sans-serif';
    document.documentElement.style.setProperty('--font-family', fontFamily);
  }, []);

  // init analytics
  useEffect(() => {
    if (!IS_DEV_ENV || IS_OVERRIDE_ANALYTICS) {
      console.log('Initializing analytics');
      const surface = getPlatform().name;
      const isWeb = surface === 'web';

      if (process.env.POSTHOG_TOKEN) {
        posthog.init(process.env.POSTHOG_TOKEN, {
          api_host: 'https://us.i.posthog.com',
          person_profiles: 'always',
          autocapture: false,
          debug: IS_OVERRIDE_ANALYTICS ? false : IS_DEV_ENV,
          // Session replay is web-only; desktop skips loading the recorder entirely.
          disable_session_recording: !isWeb,
        });
      }

      // Tag every event with the originating surface and app version so web vs desktop
      // can be filtered in PostHog/Mixpanel without instrumenting each capture site.
      const surfaceProps = {
        surface,
        app_version: packageJson.version,
      };

      if (process.env.POSTHOG_TOKEN) {
        posthog.register(surfaceProps);
        posthog.capture('Load App');
      }

      if (process.env.MIXPANEL_TOKEN) {
        mixpanel.init(process.env.MIXPANEL_TOKEN, {
          debug: IS_DEV_ENV,
          track_pageview: true,
          persistence: 'localStorage',
        });
        mixpanel.register(surfaceProps);
        mixpanel.track('Load App');
      }
    }
  }, []);

  const checkForUpdates = () => {
    platform.updates.checkForUpdates();
  };

  // Check for updates at 5min delayed from start + every 2 hours
  useEffect(() => {
    const CHECK_UPDATES_EVERY_X_HOURS = 24;
    const INITIAL_CHECK_DELAY_MS = 5 * 60 * 1000; // 5 minutes

    // Check if enough time has passed since last check
    const lastChecked = getPlatform().storage.get(
      LOCAL_STORAGE_KEYS.LAST_TIME_CHECKED_FOR_UPDATES,
    );
    const timeSinceLastCheck = lastChecked
      ? Date.now() - parseInt(lastChecked)
      : Infinity;
    const timeToWaitForChecksMs = CHECK_UPDATES_EVERY_X_HOURS * 60 * 60 * 1000;

    // Only do initial check if it's been long enough since last check
    if (timeSinceLastCheck >= timeToWaitForChecksMs) {
      setTimeout(() => {
        checkForUpdates();
        getPlatform().storage.set(
          LOCAL_STORAGE_KEYS.LAST_TIME_CHECKED_FOR_UPDATES,
          Date.now().toString(),
        );
      }, INITIAL_CHECK_DELAY_MS);
    }

    // Check for updates every 2 hours after that
    const intervalId = setInterval(() => {
      checkForUpdates();
      getPlatform().storage.set(
        LOCAL_STORAGE_KEYS.LAST_TIME_CHECKED_FOR_UPDATES,
        Date.now().toString(),
      );
    }, timeToWaitForChecksMs);

    // Clean up interval on component unmount
    return () => clearInterval(intervalId);
  }, []);

  // check actions to do after a reload
  useEffect(() => {
    // 1. Just imported --> show survey
    const justImported = getPlatform().storage.get(
      LOCAL_STORAGE_KEYS.SETTINGS.ACTIONS.JUST_IMPORTED,
    );

    // show survey after 5 seconds
    if (justImported) {
      getPlatform().storage.remove(
        LOCAL_STORAGE_KEYS.SETTINGS.ACTIONS.JUST_IMPORTED,
      );
      setTimeout(() => {
        trackEvent('Delay After Import');
      }, 5000);
    }
  }, []);

  /* Run auto export every 2 hours */
  useEffect(() => {
    const intervalId = setInterval(
      async () => {
        try {
          await exportNotesToMarkdownWithWorker();
        } catch (e) {
          console.error('Auto error exporting notes to markdown', e);
        }
      },
      2 * 60 * 60 * 1000,
    );
    return () => clearInterval(intervalId);
  }, []);

  // Sentry init now lives in src/renderer/bootstrap-electron.ts — runs once before App
  // renders on desktop. Web skips it entirely.

  /**
   * Back-up drag bar this way for some reason works
   */
  useEffect(() => {
    var windowTopBar = document.createElement('div');
    windowTopBar.style.width = '100%';
    windowTopBar.style.height = '32px';
    windowTopBar.style.backgroundColor = 'transparent';
    windowTopBar.style.position = 'absolute';
    windowTopBar.style.top = windowTopBar.style.left = 0;
    windowTopBar.style.webkitAppRegion = 'drag';
    document.body.appendChild(windowTopBar);
  }, []);

  // Web-only /auth screen. Router stays MemoryRouter on both platforms (desktop must
  // keep it), so we can't register /auth as a real react-router Route. Instead we
  // branch here on the actual browser pathname, served by Vercel's SPA rewrite
  // (/(.*) → /index.html). Desktop's capabilities.deepLinks === true so this branch
  // never fires there.
  const isWeb = !platform.capabilities.deepLinks;
  if (isWeb && window.location.pathname === '/auth') {
    return (
      <SettingsProvider>
        <Toaster
          position="bottom-center"
          toastOptions={{
            style: DEFAULT_TOAST_STYLE,
            iconTheme: TOAST_ICON_THEME,
          }}
        />
        <AuthPage />
      </SettingsProvider>
    );
  }

  // Web-only /integrations/:slug landing page. Desktop opens this URL in the
  // external browser (see src/utils/nango/nango-connect.ts) when the user
  // clicks "Connect" — the page completes OAuth (Nango) or accepts an API
  // key (custom integration), then deep-links back to the desktop. Same
  // SPA-rewrite caveat as /auth: not a Router route because MemoryRouter
  // doesn't read window.location.
  if (isWeb && window.location.pathname.startsWith('/integrations/')) {
    const slug = window.location.pathname
      .slice('/integrations/'.length)
      .replace(/\/+$/, '');
    return (
      <SettingsProvider>
        <Toaster
          position="bottom-center"
          toastOptions={{
            style: DEFAULT_TOAST_STYLE,
            iconTheme: TOAST_ICON_THEME,
          }}
        />
        <IntegrationConnectPage slug={slug} />
      </SettingsProvider>
    );
  }

  // Web-only /upgrade landing page. Renders the shared SubscriptionUpgradeScreen
  // directly so that linking to /upgrade (e.g. from marketing pages or the desktop
  // app pointing browser users at the web upgrade flow) drops people straight on
  // the pricing screen. Same MemoryRouter caveat as /auth and /integrations.
  if (isWeb && window.location.pathname.replace(/\/+$/, '') === '/upgrade') {
    return (
      <SettingsProvider>
        <Toaster
          position="bottom-center"
          toastOptions={{
            style: DEFAULT_TOAST_STYLE,
            iconTheme: TOAST_ICON_THEME,
          }}
        />
        <WebUpgradePage />
      </SettingsProvider>
    );
  }

  // Web-only /paywall landing page. Lives on the.constella.app for the
  // paywall-first experiment — useHandleAfterAuth opens this URL whenever
  // the user's subscription has paywall_variant === 'treatment' && !has_paid.
  // Same SPA-rewrite caveat as /auth, /integrations, /upgrade above.
  if (isWeb && window.location.pathname.replace(/\/+$/, '') === '/paywall') {
    return (
      <SettingsProvider>
        <Toaster
          position="bottom-center"
          toastOptions={{
            style: DEFAULT_TOAST_STYLE,
            iconTheme: TOAST_ICON_THEME,
          }}
        />
        <PaywallPage />
      </SettingsProvider>
    );
  }

  // Web-only /success landing page. Stripe's checkout success_url points here
  // after a paid upgrade — we show a brief confirmation and a "Return to
  // Constella Desktop" button that fires the constella-app-desktop://?route=
  // upgrade-success deep link so the running Electron app can refresh the
  // plan state (see SubscriptionUpgradeSuccessListener for the desktop side).
  if (isWeb && window.location.pathname.replace(/\/+$/, '') === '/success') {
    return (
      <SettingsProvider>
        <Toaster
          position="bottom-center"
          toastOptions={{
            style: DEFAULT_TOAST_STYLE,
            iconTheme: TOAST_ICON_THEME,
          }}
        />
        <CheckoutSuccessPage />
      </SettingsProvider>
    );
  }

  return (
    <SettingsProvider>
      <ReactFlowProvider>
        <Worker workerUrl={workerURL}>
          <Toaster
            position="bottom-center"
            toastOptions={{
              style: DEFAULT_TOAST_STYLE,
              iconTheme: TOAST_ICON_THEME,
            }}
          />
          <Router>
            <Routes>
              <Route path="/" element={getView()} />
            </Routes>
          </Router>
          {/* Unified capture: `/` anywhere opens the compose → expanded modal
              (home, library, canvas). Replaces the old per-screen overlays. */}
          <UnifiedCapture />
          {isClosingWindow && (
            <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-50 z-50">
              <div className="animate-spin rounded-full h-32 w-32 border-t-2 border-b-2 border-blue-500"></div>
            </div>
          )}
        </Worker>
      </ReactFlowProvider>
    </SettingsProvider>
  );
}
