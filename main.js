const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, desktopCapturer } = require('electron');
const path = require('path');
const os = require('os');
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

// MimDesk değişkenleri
let mimdeskRequestWindow = null;
let mimdeskSessionWindow = null;
let currentMimdeskRequest = null;
let mimdeskPeerConnection = null;
let mimdeskScreenStream = null;

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

    // MimDesk Agent olarak kayıt ol
    registerMimdeskAgent();
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

  // =====================
  // MimDesk Events
  // =====================

  // IT ekibinden bağlantı isteği
  socket.on('mimdesk:connection-request', (data) => {
    const { controllerId, controllerName, controllerSocketId } = data;
    console.log(`MimDesk: Bağlantı isteği - ${controllerName}`);

    currentMimdeskRequest = { controllerId, controllerName, controllerSocketId };

    // Bildirim göster
    showNotification('Uzaktan Destek İsteği', `${controllerName} bilgisayarınıza bağlanmak istiyor`, true);

    // İstek penceresi aç
    showMimdeskRequestWindow(data);
  });

  // WebRTC offer from controller
  socket.on('mimdesk:webrtc-offer', async (data) => {
    console.log('MimDesk: WebRTC offer alındı');
    if (mimdeskSessionWindow) {
      mimdeskSessionWindow.webContents.send('webrtc-offer', data);
    }
  });

  // ICE candidate from controller
  socket.on('mimdesk:ice-candidate', (data) => {
    if (mimdeskSessionWindow) {
      mimdeskSessionWindow.webContents.send('ice-candidate', data);
    }
  });

  // Session ended by controller
  socket.on('mimdesk:session-ended', (data) => {
    console.log('MimDesk: Oturum sonlandırıldı');
    showNotification('Uzaktan Destek', 'IT destek oturumu sonlandırıldı');
    endMimdeskSession();
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

// =====================
// MimDesk Fonksiyonları
// =====================

// Makine bilgisi al
function getMachineInfo() {
  const networkInterfaces = os.networkInterfaces();
  let ipAddress = 'Unknown';

  for (const name of Object.keys(networkInterfaces)) {
    for (const net of networkInterfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ipAddress = net.address;
        break;
      }
    }
  }

  return {
    computerId: os.hostname(),
    computerName: os.hostname(),
    osInfo: `${os.platform()} ${os.release()}`,
    ipAddress
  };
}

// MimDesk Agent olarak kayıt ol
function registerMimdeskAgent() {
  if (!socket || !isLoggedIn) return;

  const machineInfo = getMachineInfo();
  socket.emit('mimdesk:register-agent', machineInfo);
  console.log('MimDesk: Agent olarak kaydedildi', machineInfo.computerName);
}

// Bağlantı isteği penceresi
function showMimdeskRequestWindow(data) {
  if (mimdeskRequestWindow) {
    mimdeskRequestWindow.focus();
    mimdeskRequestWindow.webContents.send('request-data', data);
    return;
  }

  mimdeskRequestWindow = new BrowserWindow({
    width: 450,
    height: 280,
    alwaysOnTop: true,
    resizable: false,
    frame: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mimdeskRequestWindow.loadFile('mimdesk-request.html');
  mimdeskRequestWindow.setMenuBarVisibility(false);

  mimdeskRequestWindow.webContents.on('did-finish-load', () => {
    mimdeskRequestWindow.webContents.send('request-data', data);
  });

  mimdeskRequestWindow.on('closed', () => {
    mimdeskRequestWindow = null;
    // Pencere kapanırsa reddet
    if (currentMimdeskRequest) {
      rejectMimdeskConnection('Kullanıcı pencereyi kapattı');
    }
  });
}

// Bağlantıyı kabul et
function acceptMimdeskConnection() {
  if (!currentMimdeskRequest || !socket) return;

  const { controllerSocketId } = currentMimdeskRequest;
  const machineInfo = getMachineInfo();

  socket.emit('mimdesk:connection-accepted', {
    controllerSocketId,
    computerId: machineInfo.computerId
  });

  console.log('MimDesk: Bağlantı kabul edildi');

  // İstek penceresini kapat
  if (mimdeskRequestWindow) {
    mimdeskRequestWindow.close();
    mimdeskRequestWindow = null;
  }

  // Oturum penceresini aç
  showMimdeskSessionWindow();
}

// Bağlantıyı reddet
function rejectMimdeskConnection(reason = 'Kullanıcı reddetti') {
  if (!currentMimdeskRequest || !socket) return;

  const { controllerSocketId } = currentMimdeskRequest;

  socket.emit('mimdesk:connection-rejected', {
    controllerSocketId,
    reason
  });

  console.log('MimDesk: Bağlantı reddedildi -', reason);
  currentMimdeskRequest = null;
}

// Oturum penceresi
function showMimdeskSessionWindow() {
  mimdeskSessionWindow = new BrowserWindow({
    width: 400,
    height: 200,
    alwaysOnTop: true,
    resizable: false,
    frame: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mimdeskSessionWindow.loadFile('mimdesk-session.html');
  mimdeskSessionWindow.setMenuBarVisibility(false);

  mimdeskSessionWindow.webContents.on('did-finish-load', () => {
    mimdeskSessionWindow.webContents.send('session-start', {
      controllerName: currentMimdeskRequest?.controllerName || 'IT Destek'
    });
  });

  mimdeskSessionWindow.on('closed', () => {
    mimdeskSessionWindow = null;
    endMimdeskSession();
  });
}

// Oturumu sonlandır
function endMimdeskSession() {
  if (mimdeskScreenStream) {
    mimdeskScreenStream.getTracks().forEach(track => track.stop());
    mimdeskScreenStream = null;
  }

  if (mimdeskPeerConnection) {
    mimdeskPeerConnection.close();
    mimdeskPeerConnection = null;
  }

  if (mimdeskSessionWindow) {
    mimdeskSessionWindow.close();
    mimdeskSessionWindow = null;
  }

  if (currentMimdeskRequest && socket) {
    socket.emit('mimdesk:end-session', {
      targetSocketId: currentMimdeskRequest.controllerSocketId
    });
  }

  currentMimdeskRequest = null;
  console.log('MimDesk: Oturum sonlandırıldı');
}

// IPC Handlers for MimDesk
ipcMain.on('mimdesk:accept', () => {
  acceptMimdeskConnection();
});

ipcMain.on('mimdesk:reject', (event, reason) => {
  rejectMimdeskConnection(reason);
  if (mimdeskRequestWindow) {
    mimdeskRequestWindow.close();
  }
});

ipcMain.on('mimdesk:end-session', () => {
  endMimdeskSession();
});

ipcMain.handle('mimdesk:get-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 320, height: 180 }
    });
    return sources.map(source => ({
      id: source.id,
      name: source.name
    }));
  } catch (error) {
    console.error('MimDesk: Ekran kaynağı alınamadı', error);
    return [];
  }
});

ipcMain.on('mimdesk:webrtc-answer', (event, data) => {
  if (socket) {
    socket.emit('mimdesk:webrtc-answer', data);
  }
});

ipcMain.on('mimdesk:ice-candidate', (event, data) => {
  if (socket) {
    socket.emit('mimdesk:ice-candidate', data);
  }
});
