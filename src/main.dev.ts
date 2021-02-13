import 'reflect-metadata';
/* eslint global-require: off, no-console: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `yarn build` or `yarn build-main`, this file is compiled to
 * `./src/main.prod.js` using webpack. This gives us some performance wins.
 */
import 'core-js/stable';
import 'regenerator-runtime/runtime';
import path from 'path';
import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import mkdirp from 'mkdirp';
import winston from 'winston';
import MenuBuilder from './menu';
import ApiServer from './api';
import { IpcRequest, OpenFileLocationRequestBody } from './ipc';
import WinstonLoggerService from './api/src/logger/WinstonLogger';

const logsPath = path.join(app.getPath('userData'), 'logs');
const logsFilename = 'expressslrs-configurator.log';
const winstonLogger = winston.createLogger({
  level: 'debug',
  format: winston.format.simple(),
  defaultMeta: {},
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.prettyPrint(),
        winston.format.timestamp()
      ),
    }),
    new winston.transports.File({
      dirname: logsPath,
      filename: logsFilename,
      maxFiles: 10,
      maxsize: 5_000_000, // in bytes
      format: winston.format.combine(
        winston.format.prettyPrint(),
        winston.format.timestamp()
      ),
    }),
  ],
});

const logger = new WinstonLoggerService(winstonLogger);

// eslint-disable-next-line @typescript-eslint/ban-types
const handleFatalError = (err: Error | object | null | undefined) => {
  logger.error(`handling fatal error: ${err}`);
  try {
    // eslint-disable-next-line promise/no-promise-in-callback
    dialog
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      .showMessageBox(undefined, {
        type: 'error',
        buttons: ['Okay'],
        title: 'Oops! Something went wrong!',
        detail: 'Help us improve your experience by sending an error report',
        message: `Error: ${err}`,
      })
      .then(() => {
        console.log('received resp from message box');
        process.exit(1);
      })
      .catch((dialogErr) => {
        logger.error('failed to show error dialog', dialogErr.stack);
        process.exit(1);
      });
  } catch (e) {
    /*
      This API can be called safely before the ready event the app module emits, it is usually used to report errors
      in early stage of startup. If called before the app readyevent on Linux, the message will be emitted to stderr,
      and no GUI dialog will appear.
     */
    dialog.showErrorBox('Oops! Something went wrong!', `Error: ${err}`);
    process.exit(1);
  }
};
process.on('uncaughtException', (err) => {
  logger.error(`uncaughtException ${err.message}`, err.stack);
  handleFatalError(err);
});
process.on('unhandledRejection', (err) => {
  logger.error(`unhandledRejection: ${err}`);
  handleFatalError(err);
});

let mainWindow: BrowserWindow | null = null;
const localServer: ApiServer = new ApiServer();

export default class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

if (
  process.env.NODE_ENV === 'development' ||
  process.env.DEBUG_PROD === 'true'
) {
  require('electron-debug')({
    showDevTools: false,
  });
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS', 'APOLLO_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload
    )
    .catch((err: Error) => {
      logger.error(err);
    });
};

const createWindow = async () => {
  if (
    process.env.NODE_ENV === 'development' ||
    process.env.DEBUG_PROD === 'true'
  ) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  logger.log('trying to get port');
  const port = await ApiServer.getPort(3500);
  logger.log(`received unused port: ${port}`);

  logger.log('starting server...');
  const firmwaresPath = path.join(app.getPath('userData'), 'firmwares', 'git');
  const dependenciesPath = app.isPackaged
    ? path.join(process.resourcesPath, '../dependencies')
    : path.join(__dirname, '../dependencies');

  const getPlatformioPath = path.join(dependenciesPath, 'get-platformio.py');
  const platformioStateTempStoragePath = path.join(
    app.getPath('userData'),
    'platformio-temp-state-storage'
  );

  /*
    We manually prepend $PATH on Windows and macOS machines with portable Git and Python locations.
   */
  let PATH = process.env.PATH ?? '';
  const prependPATH = (pth: string, item: string): string => {
    if (pth.length > 0) {
      return `${item}${path.delimiter}${pth}`;
    }
    return item;
  };
  const isWindows = process.platform.startsWith('win');
  const isMacOS = process.platform.startsWith('darwin');
  if (isWindows) {
    const portablePythonLocation = path.join(
      dependenciesPath,
      'windows_amd64/python-portable-windows_amd64-3.7.7'
    );
    const portableGitLocation = path.join(
      dependenciesPath,
      'windows_amd64/PortableGit/bin'
    );
    PATH = prependPATH(PATH, portablePythonLocation);
    PATH = prependPATH(PATH, portableGitLocation);
  }
  if (isMacOS) {
    const portablePythonLocation = path.join(
      dependenciesPath,
      'darwin_amd64/python-portable-darwin-3.8.4/bin'
    );
    const portableGitLocation = path.join(
      dependenciesPath,
      'darwin_amd64/git/2.30.1/bin'
    );
    PATH = prependPATH(PATH, portablePythonLocation);
    PATH = prependPATH(PATH, portableGitLocation);
  }

  await mkdirp(firmwaresPath);
  const localApiServerEnv = process.env;
  localApiServerEnv.PLATFORMIO_INSTALLER_TMPDIR = app.getPath('userData');
  await localServer.start(
    {
      git: {
        cloneUrl: 'https://github.com/AlessandroAU/ExpressLRS',
        url: 'https://github.com/AlessandroAU/ExpressLRS',
        owner: 'AlessandroAU',
        repositoryName: 'ExpressLRS',
      },
      firmwaresPath,
      getPlatformioPath,
      platformioStateTempStoragePath,
      PATH,
      env: localApiServerEnv,
    },
    logger,
    port
  );
  logger.log('server started');

  mainWindow = new BrowserWindow({
    show: false,
    width: 1400,
    height: 920,
    icon: getAssetPath('icon.png'),
    // TODO: improve electron.js security
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const apiUrl = `http://localhost:${port}/graphql`;
  const subscriptionsUrl = `ws://localhost:${port}/graphql`;
  mainWindow.loadURL(
    `file://${__dirname}/index.html?api_url=${apiUrl}&subscriptions_url=${subscriptionsUrl}`
  );

  // TODO: Use 'ready-to-show' event
  //        https://github.com/electron/electron/blob/master/docs/api/browser-window.md#using-ready-to-show-event
  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }

    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // mainWindow.setMenuBarVisibility(false);
  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.on('new-window', (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  });

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  // new AppUpdater();
};
/**
 * Add event listeners...
 */

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin') {
    localServer.stop();
    app.quit();
  }
});

app
  .whenReady()
  .then(createWindow)
  .catch((err: Error) => {
    logger.error(`createWindow error ${err}`);
    handleFatalError(err);
  });

app.on('activate', () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow();
  }
});

ipcMain.on(
  IpcRequest.OpenFileLocation,
  (_, arg: OpenFileLocationRequestBody) => {
    shell.showItemInFolder(arg.path);
  }
);

ipcMain.on(IpcRequest.OpenLogsFolder, () => {
  shell.showItemInFolder(path.join(logsPath, logsFilename));
});
