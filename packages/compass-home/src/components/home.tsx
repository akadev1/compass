import {
  Body,
  CompassComponentsProvider,
  FileInputBackendProvider,
  createElectronFileInputBackend,
  css,
  cx,
  getScrollbarStyles,
  palette,
  resetGlobalCSS,
  openToast,
  ButtonVariant,
  Button,
  spacing,
  showConfirmation,
} from '@mongodb-js/compass-components';
import Connections from '@mongodb-js/compass-connections';
import { CompassFindInPagePlugin } from '@mongodb-js/compass-find-in-page';
import { useLoggerAndTelemetry } from '@mongodb-js/compass-logging/provider';
import { CompassSettingsPlugin } from '@mongodb-js/compass-settings';
import Welcome from '@mongodb-js/compass-welcome';
import * as hadronIpc from 'hadron-ipc';
import { getConnectionTitle } from '@mongodb-js/connection-info';
import {
  type ConnectionInfo,
  ConnectionStorage,
} from '@mongodb-js/connection-storage/renderer';
import { AppRegistryProvider, useLocalAppRegistry } from 'hadron-app-registry';
import {
  ConnectionsManagerProvider,
  ConnectionsManager,
} from '@mongodb-js/compass-connections/provider';
import type {
  DataService,
  ReauthenticationHandler,
} from 'mongodb-data-service';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import updateTitle from '../modules/update-title';
import Workspace from './workspace';
import {
  trackConnectionAttemptEvent,
  trackNewConnectionEvent,
  trackConnectionFailedEvent,
} from '../modules/telemetry';
// The only place where the app-stores plugin can be used as a plugin and not a
// provider
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { CompassInstanceStorePlugin } from '@mongodb-js/compass-app-stores';
import FieldStorePlugin from '@mongodb-js/compass-field-store';
import { AtlasAuthPlugin } from '@mongodb-js/atlas-service/renderer';
import type { WorkspaceTab } from '@mongodb-js/compass-workspaces';
import {
  ConnectionStorageContext,
  ConnectionRepositoryContextProvider,
} from '@mongodb-js/connection-storage/provider';
import { ConnectionInfoProvider } from '@mongodb-js/connection-storage/provider';

resetGlobalCSS();

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let remote: typeof import('@electron/remote') | undefined;
try {
  remote = require('@electron/remote');
} catch {
  /* no electron, eg. mocha tests */
}

const homeViewStyles = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  height: '100vh',
});

const hiddenStyles = css({
  display: 'none',
});

const homePageStyles = css({
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'stretch',
  flex: 1,
  overflow: 'auto',
  height: '100%',
});

const homeContainerStyles = css({
  height: '100vh',
  width: '100vw',
  overflow: 'hidden',
  // ensure modals and any other overlays will
  // paint properly above the content
  position: 'relative',
  zIndex: 0,
});

const globalLightThemeStyles = css({
  backgroundColor: palette.white,
  color: palette.gray.dark2,
});

const globalDarkThemeStyles = css({
  backgroundColor: palette.black,
  color: palette.white,
});

const restartPromptToastStyles = css({
  display: 'flex',
  flexDirection: 'row',
  div: {
    display: 'flex',
    flexDirection: 'column',
    margin: 'auto',
    padding: spacing[1],
  },
});

type State = {
  connectionInfo: ConnectionInfo | null;
  isConnected: boolean;
  hasDisconnectedAtLeastOnce: boolean;
};

const initialState: State = {
  connectionInfo: null,
  isConnected: false,
  hasDisconnectedAtLeastOnce: false,
};

type Action =
  | {
      type: 'connected';
      connectionInfo: ConnectionInfo;
    }
  | { type: 'disconnected' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'connected':
      return {
        ...state,
        isConnected: true,
        connectionInfo: action.connectionInfo,
      };
    case 'disconnected':
      return {
        // Reset to initial state, but do not automatically connect this time.
        ...initialState,
        hasDisconnectedAtLeastOnce: true,
      };
    default:
      return state;
  }
}

function showCollectionSubMenu({ isReadOnly }: { isReadOnly: boolean }) {
  void hadronIpc.ipcRenderer?.call('window:show-collection-submenu', {
    isReadOnly,
  });
}

function hideCollectionSubMenu() {
  void hadronIpc.ipcRenderer?.call('window:hide-collection-submenu');
}

function notifyMainProcessOfDisconnect() {
  void hadronIpc.ipcRenderer?.call('compass:disconnected');
}

function Home({
  appName,
  getAutoConnectInfo,
  isWelcomeModalOpenByDefault = false,
  __TEST_MONGODB_DATA_SERVICE_CONNECT_FN,
  __TEST_CONNECTION_STORAGE,
}: {
  appName: string;
  getAutoConnectInfo?: () => Promise<ConnectionInfo | undefined>;
  isWelcomeModalOpenByDefault?: boolean;
  __TEST_MONGODB_DATA_SERVICE_CONNECT_FN?: () => Promise<DataService>;
  __TEST_CONNECTION_STORAGE?: typeof ConnectionStorage;
}): React.ReactElement | null {
  const appRegistry = useLocalAppRegistry();
  const loggerAndTelemetry = useLoggerAndTelemetry('COMPASS-CONNECT-UI');

  const reauthenticationHandler = useRef<ReauthenticationHandler>(async () => {
    const confirmed = await showConfirmation({
      title: 'Authentication expired',
      description:
        'You need to re-authenticate to the database in order to continue.',
    });
    if (!confirmed) {
      throw new Error('Reauthentication declined by user');
    }
  });

  const connectionsManager = useRef(
    new ConnectionsManager({
      logger: loggerAndTelemetry.log.unbound,
      reAuthenticationHandler: reauthenticationHandler.current,
      __TEST_CONNECT_FN: __TEST_MONGODB_DATA_SERVICE_CONNECT_FN,
    })
  );

  const [
    { connectionInfo, isConnected, hasDisconnectedAtLeastOnce },
    dispatch,
  ] = useReducer(reducer, {
    ...initialState,
  });

  const onConnected = useCallback(
    (connectionInfo: ConnectionInfo, dataService: DataService) => {
      trackNewConnectionEvent(connectionInfo, dataService, loggerAndTelemetry);
      dispatch({ type: 'connected', connectionInfo: connectionInfo });
    },
    [loggerAndTelemetry]
  );

  const onConnectionFailed = useCallback(
    (connectionInfo: ConnectionInfo | null, error: Error) => {
      trackConnectionFailedEvent(connectionInfo, error, loggerAndTelemetry);
    },
    [loggerAndTelemetry]
  );

  const onConnectionAttemptStarted = useCallback(
    (connectionInfo: ConnectionInfo) => {
      trackConnectionAttemptEvent(connectionInfo, loggerAndTelemetry);
    },
    [loggerAndTelemetry]
  );

  useEffect(() => {
    async function handleDisconnectClicked() {
      if (!connectionInfo) {
        return;
      }

      await connectionsManager.current.closeConnection(connectionInfo.id);
      dispatch({ type: 'disconnected' });
    }

    function onDisconnect() {
      void handleDisconnectClicked();
    }

    hadronIpc.ipcRenderer?.on('app:disconnect', onDisconnect);

    return () => {
      // Clean up the ipc listener.
      hadronIpc.ipcRenderer?.removeListener('app:disconnect', onDisconnect);
    };
  }, [appRegistry, appName, connectionInfo]);

  const onWorkspaceChange = useCallback(
    (ws: WorkspaceTab | null, collectionInfo) => {
      const namespace =
        ws?.type === 'Collection' || ws?.type === 'Collections'
          ? ws.namespace
          : undefined;

      updateTitle(
        appName,
        connectionInfo ? getConnectionTitle(connectionInfo) : undefined,
        ws?.type,
        namespace
      );

      if (ws?.type === 'Collection') {
        showCollectionSubMenu({ isReadOnly: !!collectionInfo?.isReadonly });
      } else {
        hideCollectionSubMenu();
      }
    },
    [appName, connectionInfo]
  );

  const onDataServiceDisconnected = useCallback(() => {
    if (!isConnected) {
      updateTitle(appName);
      hideCollectionSubMenu();
      notifyMainProcessOfDisconnect();
    }
  }, [appName, isConnected]);

  useLayoutEffect(onDataServiceDisconnected);

  const electronFileInputBackendRef = useRef(
    remote ? createElectronFileInputBackend(remote) : null
  );

  const [isWelcomeOpen, setIsWelcomeOpen] = useState(
    isWelcomeModalOpenByDefault
  );

  const closeWelcomeModal = useCallback(
    (showSettings?: boolean) => {
      function close() {
        setIsWelcomeOpen(false);
        if (showSettings) {
          appRegistry.emit('open-compass-settings');
        }
      }
      void close();
    },
    [setIsWelcomeOpen, appRegistry]
  );

  useEffect(() => {
    function onAutoupdateStarted() {
      openToast('update-download', {
        variant: 'progress',
        title: 'Compass update is in progress',
      });
    }
    function onAutoupdateFailed() {
      openToast('update-download', {
        variant: 'warning',
        title: 'Failed to download Compass update',
        description: 'Downloading a newer Compass version failed',
      });
    }
    function onAutoupdateSucess() {
      openToast('update-download', {
        variant: 'note',
        title: 'Restart to start newer Compass version',
        description: (
          <div className={restartPromptToastStyles}>
            <div>
              Continuing to use Compass without restarting may cause some of the
              features to not work as intended.
            </div>
            <div>
              <Button
                variant={ButtonVariant.Primary}
                onClick={() => {
                  void hadronIpc.ipcRenderer?.call(
                    'autoupdate:update-download-restart-confirmed'
                  );
                }}
              >
                Restart Compass
              </Button>
            </div>
          </div>
        ),
        dismissible: true,
        onClose: () => {
          void hadronIpc.ipcRenderer?.call(
            'autoupdate:update-download-restart-dismissed'
          );
        },
      });
    }
    hadronIpc.ipcRenderer?.on(
      'autoupdate:update-download-in-progress',
      onAutoupdateStarted
    );
    hadronIpc.ipcRenderer?.on(
      'autoupdate:update-download-failed',
      onAutoupdateFailed
    );
    hadronIpc.ipcRenderer?.on(
      'autoupdate:update-download-success',
      onAutoupdateSucess
    );
    return () => {
      hadronIpc.ipcRenderer?.removeListener(
        'autoupdate:update-download-in-progress',
        onAutoupdateStarted
      );
      hadronIpc.ipcRenderer?.removeListener(
        'autoupdate:update-download-failed',
        onAutoupdateFailed
      );
      hadronIpc.ipcRenderer?.removeListener(
        'autoupdate:update-download-success',
        onAutoupdateSucess
      );
    };
  }, []);

  const connectionStorage =
    __TEST_CONNECTION_STORAGE === undefined
      ? ConnectionStorage
      : __TEST_CONNECTION_STORAGE;
  return (
    <FileInputBackendProvider
      createFileInputBackend={electronFileInputBackendRef.current}
    >
      <ConnectionStorageContext.Provider value={connectionStorage}>
        <ConnectionRepositoryContextProvider>
          <ConnectionsManagerProvider value={connectionsManager.current}>
            <CompassInstanceStorePlugin>
              <ConnectionInfoProvider value={connectionInfo}>
                {isConnected && connectionInfo && (
                  <AppRegistryProvider
                    key={connectionInfo.id}
                    scopeName="Connected Application"
                  >
                    <FieldStorePlugin>
                      <Workspace
                        connectionInfo={connectionInfo}
                        onActiveWorkspaceTabChange={onWorkspaceChange}
                      />
                    </FieldStorePlugin>
                  </AppRegistryProvider>
                )}
              </ConnectionInfoProvider>
            </CompassInstanceStorePlugin>
            {/* TODO(COMPASS-7397): Hide <Connections> but keep it in scope if
            connected so that the connection import/export functionality can still
            be used through the application menu */}
            <div
              className={isConnected ? hiddenStyles : homeViewStyles}
              data-hidden={isConnected}
              data-testid="connections"
            >
              <div className={homePageStyles}>
                <Connections
                  appRegistry={appRegistry}
                  onConnected={onConnected}
                  onConnectionFailed={onConnectionFailed}
                  onConnectionAttemptStarted={onConnectionAttemptStarted}
                  appName={appName}
                  getAutoConnectInfo={
                    hasDisconnectedAtLeastOnce ? undefined : getAutoConnectInfo
                  }
                />
              </div>
            </div>
            <Welcome isOpen={isWelcomeOpen} closeModal={closeWelcomeModal} />
            <CompassSettingsPlugin></CompassSettingsPlugin>
            <CompassFindInPagePlugin></CompassFindInPagePlugin>
            <AtlasAuthPlugin></AtlasAuthPlugin>
          </ConnectionsManagerProvider>
        </ConnectionRepositoryContextProvider>
      </ConnectionStorageContext.Provider>
    </FileInputBackendProvider>
  );
}

function ThemedHome(
  props: React.ComponentProps<typeof Home>
): ReturnType<typeof Home> {
  const { track } = useLoggerAndTelemetry('COMPASS-HOME-UI');

  return (
    <CompassComponentsProvider
      onNextGuideGue={(cue) => {
        track('Guide Cue Dismissed', {
          groupId: cue.groupId,
          cueId: cue.cueId,
          step: cue.step,
        });
      }}
      onNextGuideCueGroup={(cue) => {
        if (cue.groupSteps !== cue.step) {
          track('Guide Cue Group Dismissed', {
            groupId: cue.groupId,
            cueId: cue.cueId,
            step: cue.step,
          });
        }
      }}
      utmSource="compass"
      utmMedium="product"
      onSignalMount={(id) => {
        track('Signal Shown', { id });
      }}
      onSignalOpen={(id) => {
        track('Signal Opened', { id });
      }}
      onSignalPrimaryActionClick={(id) => {
        track('Signal Action Button Clicked', { id });
      }}
      onSignalLinkClick={(id) => {
        track('Signal Link Clicked', { id });
      }}
      onSignalClose={(id) => {
        track('Signal Closed', { id });
      }}
    >
      {({ darkMode, portalContainerRef }) => {
        return (
          // Wrap the page in a body typography element so that font-size and
          // line-height is standardized.
          <Body as="div">
            <div
              className={getScrollbarStyles(darkMode)}
              ref={portalContainerRef as React.Ref<HTMLDivElement>}
            >
              <div
                className={cx(
                  homeContainerStyles,
                  darkMode ? globalDarkThemeStyles : globalLightThemeStyles
                )}
                data-theme={darkMode ? 'Dark' : 'Light'}
              >
                <Home {...props}></Home>
              </div>
            </div>
          </Body>
        );
      }}
    </CompassComponentsProvider>
  );
}

export default ThemedHome;
