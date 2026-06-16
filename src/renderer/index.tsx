// Bootstrap MUST be the first import: it calls setPlatform() as a side effect so any
// module that later runs getPlatform() (stores, axios interceptors) finds a real adapter.
import './bootstrap-electron';

import { createRoot } from 'react-dom/client';

import App from './App';
import { Outgoing_Channels } from '../main/preload';
import { installBackendAccessTokenRefresh } from '../utils/api/backendAccessToken';
import { PlatformProvider } from '../platform/PlatformContext';
import { getPlatform } from '../platform/platformInstance';

// Swallow the benign "ResizeObserver loop completed with undelivered notifications"
// warning so it doesn't trigger the webpack-dev-server runtime error overlay.
// Why: browsers fire this as a non-fatal notice when observers cause layout in the
// same frame; react-error-overlay treats any window error as fatal. We stop
// propagation before the overlay's listener sees it. Capture phase + immediate
// stop is required because the overlay also registers in capture.
const RESIZE_OBSERVER_ERR =
	/ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;
window.addEventListener(
	'error',
	(event) => {
		if (event.message && RESIZE_OBSERVER_ERR.test(event.message)) {
			event.stopImmediatePropagation();
			event.preventDefault();
		}
	},
	true,
);

const container = document.getElementById('root') as HTMLElement;
const root = createRoot(container);

installBackendAccessTokenRefresh();

root.render(
	<PlatformProvider adapter={getPlatform()}>
		<App />
	</PlatformProvider>,
);
