const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const AutoLaunch = require('auto-launch');
const { io } = require('socket.io-client');

// Ayarlar
const store = new Store();
const SERVER_URL = 'https://pctalep.mimbytes.tr';

let mainWindow = null;
let tray = null;
let socket = null;
let isLoggedIn = false;
let currentUser = null;

// Auto-launch ayarı
const autoLauncher = new AutoLaunch({
  name: 'MİM IT Talep',
  path: app.getPath('exe'),
});

// Uygulama hazır olduğunda
app.whenReady().then(() => {
  createTray();

  // Kaydedilmiş oturum var mı kontrol et
  const savedToken = store.get('token');
  const savedUser = store.get('user');

  if (savedToken && savedUser) {
    currentUser = savedUser;
    isLoggedIn = true;
    connectSocket(savedToken);
    updateTrayMenu();
  } else {
    showLoginWindow();
  }

  // Auto-launch aktif et
  autoLauncher.isEnabled().then((isEnabled) => {
    if (!isEnabled) autoLauncher.enable();
  });
});

// Tray oluştur
function createTray() {
  // Kırmızı arka plan, siyah M harfi - 16x16 PNG
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon.isEmpty() ? createDefaultIcon() : icon);
  tray.setToolTip('MİM IT Talep');

  updateTrayMenu();

  tray.on('click', () => {
    if (isLoggedIn) {
      showMainWindow();
    } else {
      showLoginWindow();
    }
  });
}

// Varsayılan ikon oluştur (kırmızı kare)
function createDefaultIcon() {
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);

  for (let i = 0; i < size * size; i++) {
    // RGBA - Kırmızı
    canvas[i * 4] = 220;     // R
    canvas[i * 4 + 1] = 38;  // G
    canvas[i * 4 + 2] = 38;  // B
    canvas[i * 4 + 3] = 255; // A
  }

  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

// Tray menüsünü güncelle
function updateTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: isLoggedIn ? `${currentUser?.fullName || 'Kullanıcı'}` : 'Giriş Yapılmadı',
      enabled: false
    },
    { type: 'separator' },
    {
      label: isLoggedIn ? 'Uygulamayı Aç' : 'Giriş Yap',
      click: () => {
        if (isLoggedIn) {
          showMainWindow();
        } else {
          showLoginWindow();
        }
      }
    },
    {
      label: 'Web Paneli',
      click: () => {
        require('electron').shell.openExternal(SERVER_URL);
      }
    },
    { type: 'separator' },
    {
      label: isLoggedIn ? 'Çıkış Yap' : '',
      visible: isLoggedIn,
      click: () => {
        logout();
      }
    },
    { type: 'separator' },
    {
      label: 'Kapat',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

// Login penceresi
function showLoginWindow() {
  if (mainWindow) {
    mainWindow.close();
  }

  mainWindow = new BrowserWindow({
    width: 400,
    height: 500,
    resizable: false,
    frame: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('login.html');
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Ana pencere (chat, duyurular vs)
function showMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('main.html');
  mainWindow.setMenuBarVisibility(false);

  // Kapatma yerine gizle
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Socket.io bağlantısı
function connectSocket(token) {
  if (socket) {
    socket.disconnect();
  }

  socket = io(SERVER_URL, {
    auth: { token },
    transports: ['websocket', 'polling']
  });

  socket.on('connect', () => {
    console.log('Socket bağlandı');
    updateTrayIcon('online');
  });

  socket.on('disconnect', () => {
    console.log('Socket bağlantısı kesildi');
    updateTrayIcon('offline');
  });

  // Yeni mesaj (bireysel)
  socket.on('new_message', (data) => {
    showNotification('Yeni Mesaj', `${data.sender}: ${data.content}`);
  });

  // Mesaj alındı (bireysel chat)
  socket.on('message:receive', (data) => {
    const senderName = data.sender?.fullName || 'Birisi';
    const content = data.content?.substring(0, 100) || 'Yeni mesaj';
    showNotification('Yeni Mesaj', `${senderName}: ${content}`);
  });

  // Grup mesajı bildirimi
  socket.on('room:new_message', (data) => {
    const roomName = data.roomName || 'Grup';
    const sender = data.sender || 'Birisi';
    const content = data.content?.substring(0, 100) || 'Yeni mesaj';
    showNotification(`${roomName}`, `${sender}: ${content}`);
  });

  // Gelen arama (bireysel)
  socket.on('incoming_call', (data) => {
    showNotification('Gelen Arama', `${data.caller} arıyor...`, true);
  });

  // Gelen arama (bireysel - yeni format)
  socket.on('call:incoming', (data) => {
    const callerName = data.callerName || 'Birisi';
    showNotification('Gelen Arama', `${callerName} arıyor...`, true);
  });

  // Grup araması bildirimi
  socket.on('conference:incoming', (data) => {
    const roomName = data.roomName || 'Grup';
    const initiator = data.initiatorName || 'Birisi';
    showNotification(`${roomName} - Grup Araması`, `${initiator} grup araması başlattı`, true);
  });

  // Grup araması bildirimi (web socket room'dan)
  socket.on('conference:started', (data) => {
    const initiator = data.initiatorName || 'Birisi';
    showNotification('Grup Araması', `${initiator} grup araması başlattı`, true);
  });

  // Duyuru
  socket.on('broadcast', (data) => {
    showNotification('Duyuru', data.message, true);
    // Duyuru penceresi aç
    showBroadcastWindow(data);
  });

  // Duyuru (yeni format)
  socket.on('broadcast:receive', (data) => {
    const sender = data.sender?.fullName || 'Sistem';
    const content = data.content?.substring(0, 100) || 'Yeni duyuru';
    showNotification('Duyuru', `${sender}: ${content}`, true);
    showBroadcastWindow({ message: content, sender });
  });

  // Yeni bildirim
  socket.on('notification', (data) => {
    showNotification(data.title || 'Bildirim', data.message);
  });
}

// Tray ikonunu güncelle
function updateTrayIcon(status) {
  // TODO: Duruma göre ikon değiştir (yeşil/kırmızı nokta)
  const tooltip = status === 'online' ? 'MİM IT Talep - Bağlı' : 'MİM IT Talep - Bağlantı Yok';
  tray.setToolTip(tooltip);
}

// Bildirim göster
function showNotification(title, body, urgent = false) {
  const notification = new Notification({
    title: title,
    body: body,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    urgency: urgent ? 'critical' : 'normal',
    silent: false
  });

  notification.on('click', () => {
    showMainWindow();
  });

  notification.show();
}

// Duyuru penceresi
function showBroadcastWindow(data) {
  const broadcastWin = new BrowserWindow({
    width: 500,
    height: 300,
    alwaysOnTop: true,
    frame: true,
    resizable: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  broadcastWin.loadFile('broadcast.html');
  broadcastWin.setMenuBarVisibility(false);

  broadcastWin.webContents.on('did-finish-load', () => {
    broadcastWin.webContents.send('broadcast-data', data);
  });
}

// Login işlemi
ipcMain.handle('login', async (event, { username, password }) => {
  try {
    const response = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();

    if (response.ok && data.token) {
      store.set('token', data.token);
      store.set('user', data.user);
      currentUser = data.user;
      isLoggedIn = true;

      connectSocket(data.token);
      updateTrayMenu();

      if (mainWindow) {
        mainWindow.close();
      }
      showMainWindow();

      return { success: true, user: data.user };
    } else {
      return { success: false, error: data.error || 'Giriş başarısız' };
    }
  } catch (error) {
    return { success: false, error: 'Sunucuya bağlanılamadı' };
  }
});

// Çıkış
function logout() {
  store.delete('token');
  store.delete('user');
  currentUser = null;
  isLoggedIn = false;

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  updateTrayMenu();
  showLoginWindow();
}

ipcMain.handle('logout', () => {
  logout();
});

// Kullanıcı bilgisi al
ipcMain.handle('get-user', () => {
  return currentUser;
});

// Token al
ipcMain.handle('get-token', () => {
  return store.get('token');
});

// Uygulama kapanırken
app.on('before-quit', () => {
  app.isQuitting = true;
});

// Tüm pencereler kapandığında uygulamayı kapatma (tray'de kalsın)
app.on('window-all-closed', (e) => {
  e.preventDefault();
});
