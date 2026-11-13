import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
    import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-messaging.js";
    import {
      getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
      onAuthStateChanged, signOut, updateProfile,
      GoogleAuthProvider, OAuthProvider, signInWithPopup,
      signInWithRedirect, getRedirectResult, sendPasswordResetEmail
    } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
    import {
      getFirestore, writeBatch, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, getDocFromCache, doc, setDoc, getDoc, getDocs, deleteDoc, collection, query,
      where, orderBy, onSnapshot, addDoc, serverTimestamp, limit, updateDoc, collectionGroup, increment, arrayUnion, arrayRemove
    } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
    import {
      getDatabase, ref, onValue, onDisconnect, set as rtdbSet, serverTimestamp as rtdbServerTimestamp
    } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";

    // ---- Optional on-screen error strip: open app.html?debug=1 to turn it on (stays on for this tab). ----
    (function () {
      try {
        if (new URLSearchParams(location.search).get('debug') === '1') sessionStorage.setItem('pcdebug', '1');
        if (sessionStorage.getItem('pcdebug') !== '1') return;
      } catch (_) { return; }
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;max-height:38vh;overflow:auto;background:#7f1d1d;color:#fff;font:11px/1.35 monospace;padding:6px;white-space:pre-wrap';
      const add = (m) => { box.textContent += m + '\n'; if (!box.isConnected) document.body.appendChild(box); box.scrollTop = box.scrollHeight; };
      const oe = console.error.bind(console), ow = console.warn.bind(console);
      console.error = (...a) => { add('E: ' + a.map(x => (x && x.message) || String(x)).join(' ')); oe(...a); };
      console.warn = (...a) => { add('W: ' + a.map(x => (x && x.message) || String(x)).join(' ')); ow(...a); };
      window.addEventListener('error', (e) => add('ERR: ' + e.message));
      window.addEventListener('unhandledrejection', (e) => add('REJ: ' + ((e.reason && e.reason.message) || e.reason)));
    })();

    // Cloudinary handles chat media uploads (free tier) instead of
    // Firebase Storage, which now requires the paid Blaze plan.
    const CLOUDINARY_CLOUD_NAME = "hk5eouq3";
    const CLOUDINARY_UPLOAD_PRESET = "privatechat";
    const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`;

    // ---------- Theme (applied immediately, before Firebase, to avoid a flash) ----------
    function applyTheme(pref) {
      const html = document.documentElement;
      let effective = pref;
      if (pref === 'auto' || !pref) {
        effective = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
      }
      html.setAttribute('data-theme', effective);
      // Logo stays fixed (icon-192.png) regardless of theme — no more light/dark swap.
    }
    const savedThemePref = localStorage.getItem('privatechat-theme') || 'auto';
    applyTheme(savedThemePref);
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        const pref = localStorage.getItem('privatechat-theme') || 'auto';
        if (pref === 'auto') applyTheme('auto');
      });
    }

    // Google/Apple sign-in normally uses a popup, which works across domains. If a popup is
    // impossible (installed home-screen app, some iPhone browsers) the app falls back to a
    // redirect, and that only works when the sign-in pages are served from the SAME domain as the
    // app. To switch that on: do the one-time setup in GOOGLE-SIGNIN-DOMAIN.md, then set this to true.
    const USE_AUTH_PROXY = false;
    const AUTH_PROXY_HOST = "private-chatbox-kohl.vercel.app"; // change if you use a custom domain

    const firebaseConfig = {
      apiKey: "AIzaSyAN2iDg0QJaUweMmgKHkN53j5qCvE6lfMM",
      authDomain: (USE_AUTH_PROXY && location.hostname === AUTH_PROXY_HOST) ? AUTH_PROXY_HOST : "privatechat-83c05.firebaseapp.com",
      projectId: "privatechat-83c05",
      storageBucket: "privatechat-83c05.firebasestorage.app",
      messagingSenderId: "738424965551",
      appId: "1:738424965551:web:65453174b7b2179ba7c75a",
      measurementId: "G-30SZMRN6XM",
      databaseURL: "https://privatechat-83c05-default-rtdb.firebaseio.com"
    };

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    // Some mobile networks/browsers buffer Firestore's live stream, so updates only show after a
    // reload. This lets the SDK switch itself to long polling when streaming doesn't work.
    // Keep chats, contacts and messages saved on this device (IndexedDB). Opening the app with no
    // data/Wi-Fi then shows your saved history straight away, like WhatsApp; new messages sync when
    // you're back online, and messages you send offline are queued and sent automatically.
    let db;
    try {
      db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
        experimentalAutoDetectLongPolling: true
      });
    } catch (e) {
      console.warn('Offline storage not available, using online-only mode:', e);
      db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
    }
    const rtdb = getDatabase(app);
    const messaging = getMessaging(app);
    // Get this public key from Firebase Console → Project settings → Cloud Messaging → Web Push certificates.
    // Push notifications will remain disabled until a real VAPID public key is placed here.
    const FCM_VAPID_KEY = "PASTE_YOUR_FIREBASE_WEB_PUSH_PUBLIC_KEY_HERE";
    let fcmServiceWorkerRegistration = null;
    let fcmToken = null;
    // (Firebase Storage removed — Cloudinary handles media uploads instead, see config above)

    // Admin access: an admin is a document at admins/{their-uid} in Firestore,
    // added by hand in the Firebase Console (see FIREBASE-CONSOLE-STEPS.md).
    // The UI only reflects that document; firestore.rules enforce it for real,
    // so hiding or showing the tab here cannot be used to gain admin powers.
    let isAdminUser = false;
    async function enableAdminIfAllowed() {
      try {
        const snap = await getDoc(doc(db, 'admins', auth.currentUser.uid));
        isAdminUser = snap.exists();
      } catch (err) {
        isAdminUser = false;
      }
      if (!isAdminUser) return;
      document.getElementById('admin-subtabs').classList.remove('hidden');
      listenToAllUsersForAdmin();
      listenToPaymentClaims();
    }
    const MAX_CONTACTS = 80;

    // Country list for the app-number prefix (replaces the old hardcoded +234).
    // Not every country on earth — a practical common-country list, with Nigeria first.
    const COUNTRIES = [
      { code: 'NG', name: 'Nigeria', dial: '234' },
      { code: 'GH', name: 'Ghana', dial: '233' },
      { code: 'KE', name: 'Kenya', dial: '254' },
      { code: 'ZA', name: 'South Africa', dial: '27' },
      { code: 'EG', name: 'Egypt', dial: '20' },
      { code: 'US', name: 'United States', dial: '1' },
      { code: 'GB', name: 'United Kingdom', dial: '44' },
      { code: 'CA', name: 'Canada', dial: '1' },
      { code: 'IN', name: 'India', dial: '91' },
      { code: 'PK', name: 'Pakistan', dial: '92' },
      { code: 'BD', name: 'Bangladesh', dial: '880' },
      { code: 'FR', name: 'France', dial: '33' },
      { code: 'DE', name: 'Germany', dial: '49' },
      { code: 'IT', name: 'Italy', dial: '39' },
      { code: 'ES', name: 'Spain', dial: '34' },
      { code: 'BR', name: 'Brazil', dial: '55' },
      { code: 'MX', name: 'Mexico', dial: '52' },
      { code: 'CN', name: 'China', dial: '86' },
      { code: 'JP', name: 'Japan', dial: '81' },
      { code: 'AE', name: 'United Arab Emirates', dial: '971' },
      { code: 'SA', name: 'Saudi Arabia', dial: '966' },
      { code: 'AU', name: 'Australia', dial: '61' },
      { code: 'CM', name: 'Cameroon', dial: '237' },
      { code: 'CI', name: "Côte d'Ivoire", dial: '225' },
      { code: 'SN', name: 'Senegal', dial: '221' },
      { code: 'ET', name: 'Ethiopia', dial: '251' },
      { code: 'TZ', name: 'Tanzania', dial: '255' },
      { code: 'UG', name: 'Uganda', dial: '256' },
      { code: 'PH', name: 'Philippines', dial: '63' },
      { code: 'ID', name: 'Indonesia', dial: '62' }
    ];

    // ---------- Single-page navigation ----------
    // The landing page and conversation now live in the same app.html.
    // Opening a chat changes only the URL + view state, so there is no full
    // page reload. A direct/shared URL such as app.html?type=contact&uid=...
    // still opens the requested conversation automatically.
    let IS_CHAT_PAGE = (() => {
      const p = new URLSearchParams(location.search);
      return p.get('type') === 'contact' || p.get('type') === 'group';
    })();

    function applyRouteView() {
      document.documentElement.classList.toggle('chat-route', IS_CHAT_PAGE);
      document.body.classList.toggle('is-chat-page', IS_CHAT_PAGE);

      const chatArea = document.getElementById('chat-area');
      if (chatArea) {
        chatArea.classList.toggle('chat-area-active', IS_CHAT_PAGE);
      }

      const sidebar = document.getElementById('sidebar');
      if (sidebar) {
        sidebar.classList.toggle('open', !IS_CHAT_PAGE);
      }

      document.title = IS_CHAT_PAGE ? 'PrivateChat — Chat' : 'PrivateChat';
    }

    function chatPageUrl(params) {
      const qs = new URLSearchParams(params).toString();
      return `app.html?${qs}`;
    }

    function enterChatRoute(params, replace = false) {
      const qs = new URLSearchParams(params).toString();
      const url = `app.html?${qs}`;

      if (replace) history.replaceState({}, '', url);
      else history.pushState({}, '', url);

      IS_CHAT_PAGE = true;
      applyRouteView();
    }

    function goToChatList(pushHistory = true) {
      if (unsubMessages) { unsubMessages(); unsubMessages = null; }
      if (unsubPresence) { unsubPresence(); unsubPresence = null; }

      activeChatUser = null;
      activeGroup = null;
      replyingToMessage = null;
      editingMessageId = null;
      currentMessagesCache = [];
      IS_CHAT_PAGE = false;

      if (pushHistory) history.pushState({}, '', 'app.html');

      applyRouteView();
      renderChatsList();
      renderGroupsList();
    }

    window.addEventListener('popstate', () => {
      const p = new URLSearchParams(location.search);
      const isChat = p.get('type') === 'contact' || p.get('type') === 'group';

      if (isChat) {
        IS_CHAT_PAGE = true;
        autoOpenedChatFromUrl = false;
        applyRouteView();
        tryAutoOpenChatFromUrl('route');
      } else {
        goToChatList(false);
      }
    });

    applyRouteView();

    // ---------- State ----------
    let authMode = "login";
    let currentUserData = null; // { uid, displayName, email, appNumber }

    // ---------- App Lock state ----------
    let enteredPin = '';
    let pinSetupBuffer = '';
    let pinSetupStage = 'first'; // 'first' | 'confirm'
    let pinSetupFirstEntry = '';
    let isAppLocked = false;
    let appLockPending = false; // true once auth completes but lock hasn't been dismissed yet
    let allUsers = [];          // all registered users (admin use only now)
    let contacts = [];          // accepted contacts: [{uid, displayName, appNumber, avatar}]
    let incomingRequests = [];  // pending requests sent TO me
    let activeChatUser = null;  // the user object currently chatting with
    let activeChatType = 'contact'; // 'contact' | 'group'
    let activeGroup = null;     // the group object currently open, when activeChatType === 'group'
    let groups = [];            // groups I'm a member of
    let unsubGroups = null;
    let chatListPresenceListeners = new Map(); // uid -> unsubscribe function, prevents duplicate onValue listeners

    // ---------- Status/Stories state ----------
    let myStatuses = [];         // my own active statuses
    let contactStatusGroups = []; // [{uid, displayName, avatar, statuses: [...]}] for contacts with active statuses
    let unsubMyStatuses = null;
    let unsubContactStatuses = {}; // uid -> unsubscribe
    let pendingStatusPhoto = null;
    let pendingStatusVideo = null;
    let statusHideFromSet = new Set();
    let statusViewerQueue = [];   // flat list of {uid, displayName, avatar, statuses} being viewed in order
    let statusViewerGroupIndex = 0;
    let statusViewerItemIndex = 0;
    let statusViewerTimer = null;
    let statusTimerRemaining = 0, statusTimerStartedAt = 0, statusHoldStart = 0, statusSuppressNavUntil = 0;
    const statusLocks = { hold: false, tap: false, input: false };
    const STATUS_DURATION_MS = 24 * 60 * 60 * 1000;
    let groupAvatarSelection = '👥';
    let groupSelectedMemberIds = new Set();
    let groupSelectedMemberInfo = {}; // uid -> {displayName, avatar, appNumber}
    let isSidebarOpen = false;
    let unsubMessages = null;   // live listener cleanup for messages
    let unsubUsers = null;
    let unsubContacts = null;
    let unsubIncoming = null;
    let unsubPresence = null;   // presence of the currently open chat partner
    let unsubGlobalMsgWatchers = {}; // per-contact message listeners for notifications
    let discoverLoadedOnce = false;

    // ---------- Calling state ----------
    let peerConnection = null;
    let localStream = null;
    let currentCallId = null;
    let currentCallType = null; // 'voice' | 'video'
    let callRole = null;        // 'caller' | 'callee'
    let unsubCallDoc = null;
    let unsubIceCandidates = null;
    let unsubIncomingCalls = null;
    let isMuted = false;
    let isCameraOff = false;

    // TURN + STUN via Metered.ca (free tier). This fixes calls failing
    // between people on different networks (mobile data, strict NATs, etc.)
    // since STUN alone can't traverse every network — TURN relays the
    // media when a direct peer-to-peer path can't be found.
    const RTC_CONFIG = {
      iceServers: [
        { urls: 'stun:stun.relay.metered.ca:80' },
        {
          urls: 'turn:standard.relay.metered.ca:80',
          username: '1cb9598b20987c742436cce7',
          credential: 'YjG+JeqZUqNIRYR4'
        },
        {
          urls: 'turn:standard.relay.metered.ca:80?transport=tcp',
          username: '1cb9598b20987c742436cce7',
          credential: 'YjG+JeqZUqNIRYR4'
        },
        {
          urls: 'turn:standard.relay.metered.ca:443',
          username: '1cb9598b20987c742436cce7',
          credential: 'YjG+JeqZUqNIRYR4'
        },
        {
          urls: 'turns:standard.relay.metered.ca:443?transport=tcp',
          username: '1cb9598b20987c742436cce7',
          credential: 'YjG+JeqZUqNIRYR4'
        }
      ]
    };
    let currentMessagesCache = [];
    let replyingToMessage = null; // { id, text, senderName }
    let editingMessageId = null;  // message id currently being edited, or null

    window.setAuthMode = function (mode) {
      authMode = mode;
      const loginBtn = document.getElementById('mode-login-btn');
      const signupBtn = document.getElementById('mode-signup-btn');
      const nameField = document.getElementById('displayname-field');
      const countryField = document.getElementById('country-field');
      const submitText = document.getElementById('auth-submit-text');
      const title = document.getElementById('auth-title');
      const subtitle = document.getElementById('auth-subtitle');
      const card = document.getElementById('auth-card');
      const forgotLink = document.getElementById('forgot-password-link');

      if (mode === 'login') {
        loginBtn.classList.add('auth-toggle-active');
        loginBtn.classList.remove('auth-toggle-inactive');
        signupBtn.classList.add('auth-toggle-inactive');
        signupBtn.classList.remove('auth-toggle-active');
        nameField.classList.add('hidden');
        countryField.classList.add('hidden');
        submitText.textContent = 'Log In';
        title.textContent = 'Welcome Back';
        subtitle.textContent = 'Sign in to keep chatting privately';
        forgotLink.classList.remove('hidden');
      } else {
        signupBtn.classList.add('auth-toggle-active');
        signupBtn.classList.remove('auth-toggle-inactive');
        loginBtn.classList.add('auth-toggle-inactive');
        loginBtn.classList.remove('auth-toggle-active');
        nameField.classList.remove('hidden');
        countryField.classList.remove('hidden');
        populateCountryDropdown();
        submitText.textContent = 'Sign Up';
        title.textContent = 'Hello, Friend!';
        subtitle.textContent = 'Create an account to get started';
        forgotLink.classList.add('hidden');
      }
      card.classList.remove('auth-card-pulse');
      void card.offsetWidth;
      card.classList.add('auth-card-pulse');
      hideAuthError();
    };

    let countryDropdownPopulated = false;
    function populateCountryDropdown() {
      if (countryDropdownPopulated) return;
      const select = document.getElementById('signup-country');
      select.innerHTML = COUNTRIES.map(c => `<option value="${c.code}">${c.name} (+${c.dial})</option>`).join('');
      countryDropdownPopulated = true;
    }

    function showAuthError(msg) {
      const el = document.getElementById('auth-error');
      el.textContent = msg;
      el.classList.remove('hidden', 'bg-green-900/40', 'border-green-700', 'text-green-300');
      el.classList.add('bg-red-900/40', 'border', 'border-red-700', 'text-red-300');
    }
    function hideAuthError() {
      document.getElementById('auth-error').classList.add('hidden');
    }
    function setAuthLoading(loading) {
      document.getElementById('auth-submit-btn').disabled = loading;
      document.getElementById('auth-submit-spinner').classList.toggle('hidden', !loading);
    }
    function setSocialLoading(which, loading) {
      const btn = document.getElementById(`${which}-btn`);
      const spinner = document.getElementById(`${which}-btn-spinner`);
      const text = document.getElementById(`${which}-btn-text`);
      btn.disabled = loading;
      spinner.classList.toggle('hidden', !loading);
      text.classList.toggle('hidden', loading);
    }

    // Generate a unique in-app "phone number", e.g. +234-APP-482913
    function generateAppNumber(dialCode) {
      const digits = Math.floor(100000 + Math.random() * 900000);
      const code = dialCode || '234'; // default to Nigeria if no country was selected (e.g. social sign-in)
      return `+${code}-APP-${digits}`;
    }

    const AVATARS = ["😀","😎","🦁","🐼","🐸","🦊","🐧","🐵","🦋","🐙","🌟","🔥","⚡","🌈","🍀","🎯"];
    function pickAvatar() {
      return AVATARS[Math.floor(Math.random() * AVATARS.length)];
    }

    // Create the Firestore profile doc if it doesn't exist yet (used by all sign-in methods)
    async function ensureUserProfile(user, fallbackName, dialCode) {
      const ref = doc(db, "users", user.uid);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        const appNumber = generateAppNumber(dialCode);
        await setDoc(ref, {
          uid: user.uid,
          displayName: user.displayName || fallbackName || "New User",
          email: user.email || "",
          appNumber,
          avatar: pickAvatar(),
          region: "",
          profession: "",
          readReceiptsEnabled: true,
          createdAt: serverTimestamp()
        });
      }
    }

    // ---------- Email/password auth ----------
    window.handleAuthSubmit = async function () {
      hideAuthError();
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;

      if (!email || !password) {
        showAuthError("Please fill in email and password.");
        return;
      }
      if (password.length < 6) {
        showAuthError("Password must be at least 6 characters.");
        return;
      }

      setAuthLoading(true);
      try {
        if (authMode === 'signup') {
          const displayName = document.getElementById('display-name').value.trim();
          if (!displayName) {
            showAuthError("Please enter a display name.");
            setAuthLoading(false);
            return;
          }
          const countrySelect = document.getElementById('signup-country');
          const selectedCountry = COUNTRIES.find(c => c.code === countrySelect.value) || COUNTRIES[0];
          const cred = await createUserWithEmailAndPassword(auth, email, password);
          await updateProfile(cred.user, { displayName });
          await ensureUserProfile(cred.user, displayName, selectedCountry.dial);
        } else {
          await signInWithEmailAndPassword(auth, email, password);
        }
        // onAuthStateChanged will take it from here
      } catch (err) {
        setAuthLoading(false);
        showAuthError(friendlyAuthError(err.code));
        return;
      }
    };

    // ---------- Forgot password ----------
    window.handleForgotPassword = async function () {
      hideAuthError();
      const email = document.getElementById('email').value.trim();

      if (!email) {
        showAuthError("Enter your email above first, then tap 'Forgot password?' to get a reset link.");
        return;
      }

      const link = document.getElementById('forgot-password-link');
      const originalText = link.textContent;
      link.textContent = 'Sending...';
      link.disabled = true;

      try {
        await sendPasswordResetEmail(auth, email);
        link.textContent = originalText;
        link.disabled = false;
        const errEl = document.getElementById('auth-error');
        errEl.textContent = `Reset link sent to ${email}. Check your inbox (and spam folder).`;
        errEl.classList.remove('hidden');
        errEl.classList.remove('bg-red-900/40', 'border-red-700', 'text-red-300');
        errEl.classList.add('bg-green-900/40', 'border', 'border-green-700', 'text-green-300');
      } catch (err) {
        link.textContent = originalText;
        link.disabled = false;
        showAuthError(friendlyAuthError(err.code));
      }
    };

    // Popup first on every device: the page never reloads, so the app moves to the chat
    // the same way it does after an email sign-up. Only if a popup is impossible (blocked, or
    // an installed home-screen app) do we fall back to the redirect flow.
    async function signInWithProvider(provider, which) {
      try {
        const cred = await signInWithPopup(auth, provider);
        await ensureUserProfile(cred.user);
        // onAuthStateChanged takes over
      } catch (err) {
        if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
          await signInWithRedirect(auth, provider);
          return; // page will navigate away; result handled on return via getRedirectResult
        }
        throw err;
      }
    }

    // ---------- Google sign-in ----------
    window.handleGoogleSignIn = async function () {
      hideAuthError();
      setSocialLoading('google', true);
      try {
        await signInWithProvider(new GoogleAuthProvider(), 'google');
      } catch (err) {
        setSocialLoading('google', false);
        if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
          showAuthError(friendlyAuthError(err.code));
        }
      }
    };

    // ---------- Apple sign-in ----------
    // Requires: Apple Developer account, Services ID + private key configured
    // in Firebase Console > Authentication > Sign-in method > Apple.
    window.handleAppleSignIn = async function () {
      hideAuthError();
      setSocialLoading('apple', true);
      try {
        const provider = new OAuthProvider('apple.com');
        provider.addScope('email');
        provider.addScope('name');
        await signInWithProvider(provider, 'apple');
      } catch (err) {
        setSocialLoading('apple', false);
        if (err.code === 'auth/operation-not-allowed') {
          showAuthError("Apple Sign-In isn't configured yet in Firebase Console.");
        } else if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
          showAuthError(friendlyAuthError(err.code));
        }
      }
    };

    // Handle the return trip from signInWithRedirect (mobile flow)
    getRedirectResult(auth).then(async (cred) => {
      if (cred && cred.user) {
        await ensureUserProfile(cred.user);
        // onAuthStateChanged will pick this up automatically
      }
    }).catch((err) => {
      if (err && err.code && err.code !== 'auth/no-current-user') {
        showAuthError(friendlyAuthError(err.code));
      }
    });

    function friendlyAuthError(code) {
      const map = {
        'auth/email-already-in-use': 'That email is already registered. Try logging in.',
        'auth/invalid-email': 'That email address looks invalid.',
        'auth/weak-password': 'Password is too weak (min 6 characters).',
        'auth/user-not-found': 'No account found with that email.',
        'auth/wrong-password': 'Incorrect password.',
        'auth/invalid-credential': 'Incorrect email or password.',
        'auth/too-many-requests': 'Too many attempts. Try again later.',
        'auth/account-exists-with-different-credential': 'An account already exists with this email using a different sign-in method.',
        'auth/operation-not-allowed': 'This sign-in method is not enabled yet.'
      };
      return map[code] || 'Something went wrong. Please try again.';
    }

    // ---------- Auth state ----------
    // ---------- Push notifications (Firebase Cloud Messaging) ----------
    async function setupPushNotifications({requestPermission = false} = {}) {
      if (!('Notification' in window) || !('serviceWorker' in navigator)) {
        return {ok:false, reason:'This browser does not support web push.'};
      }
      if (!FCM_VAPID_KEY || FCM_VAPID_KEY.includes('PASTE_YOUR_')) {
        return {ok:false, reason:'Add your Firebase Web Push public VAPID key in app.js first.'};
      }
      if (!auth.currentUser) return {ok:false, reason:'Please sign in first.'};

      try {
        let permission = Notification.permission;
        if (requestPermission && permission !== 'granted') {
          permission = await Notification.requestPermission();
        }
        if (permission !== 'granted') {
          return {ok:false, reason:'Notification permission was not granted.'};
        }

        fcmServiceWorkerRegistration = await navigator.serviceWorker.register('./firebase-messaging-sw.js');
        fcmToken = await getToken(messaging, {
          vapidKey: FCM_VAPID_KEY,
          serviceWorkerRegistration: fcmServiceWorkerRegistration
        });
        if (!fcmToken) return {ok:false, reason:'Firebase did not return a push token.'};

        await setDoc(
          doc(db, 'users', auth.currentUser.uid, 'fcmTokens', encodeURIComponent(fcmToken)),
          {
            token: fcmToken,
            platform: 'web',
            updatedAt: serverTimestamp(),
            userAgent: navigator.userAgent.slice(0, 300)
          },
          {merge:true}
        );
        return {ok:true};
      } catch (err) {
        console.error('FCM setup failed:', err);
        return {ok:false, reason: err?.message || 'Could not enable notifications.'};
      }
    }

    window.enablePushNotifications = async function () {
      const result = await setupPushNotifications({requestPermission:true});
      const box = document.getElementById('push-notification-status');
      if (!box) return;
      box.classList.remove('hidden');
      box.textContent = result.ok
        ? 'Notifications are enabled on this device.'
        : result.reason;
      box.className = result.ok
        ? 'mt-2 text-xs text-green-400'
        : 'mt-2 text-xs text-red-400';
      syncPushNotificationUI();
    };

    function syncPushNotificationUI() {
      const btn = document.getElementById('push-notification-btn');
      const status = document.getElementById('push-notification-status');
      if (!btn || !status) return;
      // Until the Web Push key is configured, push can't work, so don't show a half-working option to users.
      const pushBlock = document.getElementById('push-notification-block');
      if (pushBlock) pushBlock.classList.toggle('hidden', !FCM_VAPID_KEY || FCM_VAPID_KEY.includes('PASTE_YOUR_'));
      if (!('Notification' in window)) {
        btn.disabled = true;
        btn.textContent = 'Notifications not supported';
        return;
      }
      if (Notification.permission === 'granted') {
        btn.innerHTML = '<i class="fas fa-bell mr-2"></i>Notifications Enabled';
        btn.classList.remove('bg-blue-600','hover:bg-blue-700');
        btn.classList.add('bg-green-700');
      } else {
        btn.innerHTML = '<i class="fas fa-bell mr-2"></i>Enable Notifications';
        btn.classList.remove('bg-green-700');
        btn.classList.add('bg-blue-600','hover:bg-blue-700');
      }
    }

    onMessage(messaging, (payload) => {
      // Foreground messages are delivered here. Avoid duplicating the browser
      // notification when the page is already visible; show a small notification
      // only when permission is available.
      if (document.visibilityState === 'visible' && Notification.permission === 'granted') {
        const title = payload.notification?.title || payload.data?.title || 'PrivateChat';
        const body = payload.notification?.body || payload.data?.body || 'You have a new message';
        try { new Notification(title, { body, icon: './icon-192.png', tag: payload.data?.messageId || 'privatechat' }); } catch (_) {}
      }
    });

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        // Saved profile first (instant, works with no network); refresh from the server in the background.
        const userRef = doc(db, "users", user.uid);
        let cachedSnap = null;
        try { cachedSnap = await getDocFromCache(userRef); } catch (_) {}
        if (cachedSnap && cachedSnap.exists()) {
          currentUserData = cachedSnap.data();
          getDoc(userRef).then(s => { if (s.exists() && currentUserData) currentUserData = { ...currentUserData, ...s.data() }; }).catch(() => {});
        } else {
          let snap;
          try { snap = await getDoc(userRef); }
          catch (e) {
            console.error('Could not load profile (offline on first login?):', e);
            document.getElementById('loading-screen').classList.add('hidden');
            showAuthError("You're offline. Connect to the internet once to finish signing in.");
            return;
          }
          if (!snap.exists()) await ensureUserProfile(user);
          const freshSnap = await getDoc(userRef);
          currentUserData = freshSnap.data();
        }

        // Presence should start the moment someone is authenticated —
        // it shouldn't wait on onboarding completion, since it's just
        // "are they signed in and connected," not an app-access gate.
        setupPresence(user.uid);

        if (!currentUserData.policyAccepted) {
          showOnboardingGate();
          return; // don't enter the main app until onboarding completes
        }

        showMainApp();
        listenToContacts();
        listenToIncomingRequests();
        listenToSentRequests();
        listenForIncomingCalls();
        listenForGroupCalls();
        listenToGroups();
        listenToReminders();
        listenToMyStatuses();
        listenToCallHistory();
        enableAdminIfAllowed();
      } else {
        currentUserData = null;
        abortAllOutbox();
        showLoginPage();
        if (unsubUsers) unsubUsers();
        if (typeof unsubClaims !== 'undefined' && unsubClaims) { unsubClaims(); unsubClaims = null; }
        if (unsubMessages) unsubMessages();
        if (unsubContacts) unsubContacts();
        if (unsubIncoming) unsubIncoming();
        if (unsubSentRequests) { unsubSentRequests(); unsubSentRequests = null; }
        if (unsubPresence) unsubPresence();
        if (unsubIncomingCalls) unsubIncomingCalls();
        stopConnectionMonitor();
        if (unsubGroupCalls) { unsubGroupCalls(); unsubGroupCalls = null; }
        if (groupCall) groupCleanup();
        if (unsubGroups) unsubGroups();
        if (unsubReminders) unsubReminders();
        if (unsubMyStatuses) unsubMyStatuses();
        if (callHistoryUnsub) callHistoryUnsub();
        Object.values(unsubContactStatuses).forEach(unsub => unsub());
        unsubContactStatuses = {};
        chatListPresenceListeners.forEach(unsub => unsub());
        chatListPresenceListeners.clear();
        teardownCall();
      }
    });

    // ---------- Connection status ----------
    // Shows "Connecting…" whenever the phone has no working link to the server (no data, weak network,
    // or the server not answering), and a short green "Connected" when it is back. The signal is
    // Firestore's own: if it is serving only saved copies (fromCache), messages and calls can't get through.
    let connState = 'connecting';
    let connUnsub = null, connHideTimer = null;
    const connBar = document.createElement('div');
    connBar.id = 'connection-bar';
    connBar.className = 'hidden fixed top-0 left-0 right-0 z-[200] text-white text-xs text-center py-1';
    connBar.style.paddingTop = 'calc(env(safe-area-inset-top, 0px) + 4px)';
    (function mountBar() {
      if (document.body) document.body.appendChild(connBar);
      else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(connBar));
    })();

    function setConnState(next) {
      if (next === connState && !(next === 'connecting' && connBar.classList.contains('hidden'))) return;
      const prev = connState;
      connState = next;
      clearTimeout(connHideTimer);
      if (next === 'connecting') {
        connBar.className = 'fixed top-0 left-0 right-0 z-[200] text-white text-xs text-center py-1 bg-amber-600';
        connBar.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Connecting… messages and calls will go through when you are connected.';
      } else if (prev === 'connecting') {
        connBar.className = 'fixed top-0 left-0 right-0 z-[200] text-white text-xs text-center py-1 bg-green-600';
        connBar.innerHTML = '<i class="fas fa-check"></i> Connected';
        connHideTimer = setTimeout(() => connBar.classList.add('hidden'), 2000);
      } else {
        connBar.classList.add('hidden');
      }
    }

    function startConnectionMonitor() {
      stopConnectionMonitor();
      setConnState('connecting');
      // Watching my own profile doc with metadata changes tells us if the server is really reachable.
      connUnsub = onSnapshot(doc(db, "users", currentUserData.uid), { includeMetadataChanges: true }, (snap) => {
        const live = !snap.metadata.fromCache && navigator.onLine;
        setConnState(live ? 'connected' : 'connecting');
      }, () => setConnState('connecting'));
    }
    function stopConnectionMonitor() {
      if (connUnsub) { connUnsub(); connUnsub = null; }
      connBar.classList.add('hidden');
    }
    window.addEventListener('offline', () => setConnState('connecting'));
    // When the browser says we're back, Firestore confirms within moments (the snapshot above flips the bar to Connected).

    // True when messages/calls can reach the server right now.
    function isServerReachable() { return navigator.onLine && connState === 'connected'; }

    // ---------- Onboarding gate: country + policy acceptance ----------
    function showOnboardingGate() {
      document.getElementById('loading-screen').classList.add('hidden');
      document.getElementById('login-page').classList.add('hidden');
      document.getElementById('main-app').classList.add('hidden');

      const select = document.getElementById('onboarding-country');
      select.innerHTML = COUNTRIES.map(c => `<option value="${c.code}">${c.name} (+${c.dial})</option>`).join('');

      // Best-effort: if their existing app number already encodes a dial
      // code (e.g. old accounts, or ones created before this gate existed),
      // preselect the matching country instead of defaulting to the first one.
      const existingDial = (currentUserData.appNumber || '').match(/^\+(\d+)-APP-/);
      if (existingDial) {
        const match = COUNTRIES.find(c => c.dial === existingDial[1]);
        if (match) select.value = match.code;
      }

      document.getElementById('onboarding-policy-check').checked = false;
      document.getElementById('onboarding-error').classList.add('hidden');
      document.getElementById('onboarding-modal').classList.remove('hidden');
    }

    window.completeOnboarding = async function () {
      const errEl = document.getElementById('onboarding-error');
      errEl.classList.add('hidden');

      const countryCode = document.getElementById('onboarding-country').value;
      const accepted = document.getElementById('onboarding-policy-check').checked;

      if (!accepted) {
        errEl.textContent = 'Please accept the Privacy Policy to continue.';
        errEl.classList.remove('hidden');
        return;
      }

      const submitText = document.getElementById('onboarding-submit-text');
      const submitSpinner = document.getElementById('onboarding-submit-spinner');
      submitText.classList.add('hidden');
      submitSpinner.classList.remove('hidden');

      try {
        const selectedCountry = COUNTRIES.find(c => c.code === countryCode) || COUNTRIES[0];
        const updates = {
          country: selectedCountry.code,
          // Regenerate the app number using the country actually picked here —
          // Google/Apple sign-in has no country step, so the number created at
          // account creation always defaulted to Nigeria until now.
          appNumber: generateAppNumber(selectedCountry.dial),
          policyAccepted: true,
          policyAcceptedAt: serverTimestamp()
        };
        await updateDoc(doc(db, "users", currentUserData.uid), updates);
        currentUserData = { ...currentUserData, ...updates };

        document.getElementById('onboarding-modal').classList.add('hidden');
        showMainApp();
        listenToContacts();
        listenToIncomingRequests();
        listenToSentRequests();
        listenForIncomingCalls();
        listenForGroupCalls();
        listenToGroups();
        listenToReminders();
        listenToMyStatuses();
        listenToCallHistory();
        enableAdminIfAllowed();
      } catch (err) {
        submitText.classList.remove('hidden');
        submitSpinner.classList.add('hidden');
        errEl.textContent = 'Something went wrong — please try again.';
        errEl.classList.remove('hidden');
      }
    };

    // ---------- Presence (Realtime Database) ----------
    function setupPresence(uid) {
      const myPresenceRef = ref(rtdb, `presence/${uid}`);
      const connectedRef = ref(rtdb, '.info/connected');
      onValue(connectedRef, (snap) => {
        if (snap.val() === true) {
          onDisconnect(myPresenceRef).set({ online: false, lastSeen: rtdbServerTimestamp() });
          rtdbSet(myPresenceRef, { online: true, lastSeen: rtdbServerTimestamp() });
        }
      });
    }

    function watchPresenceFor(uid) {
      if (unsubPresence) unsubPresence();
      const pRef = ref(rtdb, `presence/${uid}`);
      unsubPresence = onValue(pRef, (snap) => {
        const val = snap.val();
        const dot = document.getElementById('chat-presence-dot');
        const statusEl = document.getElementById('chat-status');
        if (val && val.online) {
          dot.classList.remove('hidden');
          statusEl.textContent = 'Online';
          statusEl.classList.add('text-green-400');
        } else {
          dot.classList.add('hidden');
          statusEl.classList.remove('text-green-400');
          if (val && val.lastSeen) {
            statusEl.textContent = 'Last seen ' + timeAgo(val.lastSeen);
          } else {
            statusEl.textContent = activeChatUser ? activeChatUser.appNumber : '';
          }
        }
      });
    }

    function timeAgo(ts) {
      const diff = Math.max(0, Date.now() - ts);
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      return `${Math.floor(hrs / 24)}d ago`;
    }

    function showLoginPage() {
      document.getElementById('loading-screen').classList.add('hidden');
      document.getElementById('main-app').classList.add('hidden');
      document.getElementById('onboarding-modal').classList.add('hidden');
      document.getElementById('admin-subtabs').classList.add('hidden');
      isAdminUser = false;
      if (typeof stopFeed === 'function') stopFeed();
      document.getElementById('login-page').classList.remove('hidden');
      document.getElementById('login-page').classList.add('flex');
      setAuthLoading(false);
      setSocialLoading('google', false);
      setSocialLoading('apple', false);
    }

    function showMainApp() {
      startConnectionMonitor();
      document.getElementById('loading-screen').classList.add('hidden');
      document.getElementById('login-page').classList.add('hidden');
      document.getElementById('onboarding-modal').classList.add('hidden');
      document.getElementById('main-app').classList.remove('hidden');

      document.getElementById('current-user').textContent = currentUserData.displayName;
      document.getElementById('current-user-number').textContent = currentUserData.appNumber;
      const emojiEl = document.getElementById('my-avatar-emoji');
      if (emojiEl) emojiEl.textContent = currentUserData.avatar || '👤';

      // Fresh page load/reopen with app lock already set up — lock immediately.
      if (appLockEnabled()) {
        showAppLockScreen();
      }
    }

    window.logout = async function () {
      await signOut(auth);
      activeChatUser = null;
    };

    // ---------- Admin: full user directory (admin only) ----------
    function listenToAllUsersForAdmin() {
      const q = collection(db, "users");
      unsubUsers = onSnapshot(q, (snap) => {
        allUsers = [];
        snap.forEach(d => {
          const u = d.data();
          if (u.uid !== currentUserData.uid) allUsers.push(u);
        });
        renderAdminList();
      });
    }

    function renderAdminList() {
      const container = document.getElementById('admin-users-list');
      if (allUsers.length === 0) {
        container.innerHTML = `<p class="text-gray-500 text-sm text-center mt-8">No other users registered yet.</p>`;
        return;
      }
      container.innerHTML = allUsers.map(u => `
        <div class="flex items-center gap-3 p-3 bg-gray-800/50 rounded-2xl">
          <div class="w-10 h-10 bg-gray-700 rounded-2xl flex items-center justify-center text-2xl shrink-0">${u.avatar || '👤'}</div>
          <div class="flex-1 min-w-0">
            <p class="font-medium truncate">${escapeHtml(u.displayName)}</p>
            <p class="text-xs text-gray-400 truncate">${u.email} • ${u.appNumber}</p>
          </div>
          <button onclick="adminGrantFeed('${u.uid}', 30)" title="Give 30 days of Feed" class="text-green-400 hover:text-green-300 px-2 shrink-0"><i class="fas fa-calendar-plus"></i></button>
          <button onclick="adminGrantFeed('${u.uid}', 0)" title="Remove Feed access" class="text-amber-400 hover:text-amber-300 px-2 shrink-0"><i class="fas fa-ban"></i></button>
          <button onclick="adminRemoveUser('${u.uid}', '${escapeHtml(u.displayName)}')" title="Remove user" class="text-red-400 hover:text-red-300 px-2 shrink-0">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      `).join('');
    }

    window.adminRemoveUser = async function (uid, name) {
      if (!confirm(`Remove ${name}'s profile from the directory? This deletes their user record, not their login.`)) return;
      await deleteDoc(doc(db, "users", uid));
    };

    // ---------- Admin: broadcast to every user as "PrivateChat Support" ----------
    window.handleBroadcast = async function () {
      const textEl = document.getElementById('broadcast-text');
      const text = textEl.value.trim();
      const resultEl = document.getElementById('broadcast-result');
      if (!text || !isAdminUser) return;

      const btnText = document.getElementById('broadcast-btn-text');
      const btnSpinner = document.getElementById('broadcast-btn-spinner');
      const btn = document.getElementById('broadcast-btn');
      btn.disabled = true;
      btnSpinner.classList.remove('hidden');
      btnText.classList.add('hidden');
      resultEl.classList.add('hidden');

      try {
        const usersSnap = await getDocs(collection(db, "users"));
        let sent = 0;

        for (const userDoc of usersSnap.docs) {
          const target = userDoc.data();
          if (target.uid === currentUserData.uid) continue;

          // Ensure both sides have an accepted contact link so it shows straight in their Chats list
          const theirContactRef = doc(db, "users", target.uid, "contacts", currentUserData.uid);
          const theirContactSnap = await getDoc(theirContactRef);
          if (!theirContactSnap.exists() || theirContactSnap.data().status !== 'accepted') {
            await setDoc(theirContactRef, {
              uid: currentUserData.uid, displayName: "PrivateChat Support", appNumber: currentUserData.appNumber,
              avatar: "🛡️", status: 'accepted', createdAt: serverTimestamp()
            });
          }
          const myContactRef = doc(db, "users", currentUserData.uid, "contacts", target.uid);
          const myContactSnap = await getDoc(myContactRef);
          if (!myContactSnap.exists() || myContactSnap.data().status !== 'accepted') {
            await setDoc(myContactRef, {
              uid: target.uid, displayName: target.displayName, appNumber: target.appNumber,
              avatar: target.avatar || '👤', status: 'accepted', createdAt: serverTimestamp()
            });
          }

          const chatId = chatIdFor(target.uid);
          await addDoc(collection(db, "chats", chatId, "messages"), {
            text,
            senderId: currentUserData.uid,
            recipientId: target.uid,
            senderNameOverride: "PrivateChat Support",
            senderAvatarOverride: "🛡️",
            isBroadcast: true,
            createdAt: serverTimestamp()
          });
          sent++;
        }

        resultEl.textContent = `Sent to ${sent} user${sent === 1 ? '' : 's'} ✅`;
        resultEl.className = 'mt-2 text-xs text-green-400';
        resultEl.classList.remove('hidden');
        textEl.value = '';
      } catch (err) {
        resultEl.textContent = 'Broadcast failed — check console for details.';
        resultEl.className = 'mt-2 text-xs text-red-400';
        resultEl.classList.remove('hidden');
        console.error(err);
      } finally {
        btn.disabled = false;
        btnSpinner.classList.add('hidden');
        btnText.classList.remove('hidden');
      }
    };

    // ==========================================================
    // GROUPS
    // Data model: groups/{groupId} { name, avatar, createdBy, admins: [uid],
    // members: [uid], memberInfo: {uid: {displayName, avatar}}, createdAt }
    // Messages live in groups/{groupId}/messages, same shape as 1-on-1 chats
    // plus senderName/senderAvatar since there's no single "other person".
    // ==========================================================

    // While online, quietly download the latest messages of your most recent chats so they are saved
    // on this device even if you never opened them this session. Offline, they then open instantly.
    const prefetchedChats = new Set();
    let prefetchRunning = false;
    async function prefetchRecentChats() {
      if (prefetchRunning || !navigator.onLine || !currentUserData) return;
      prefetchRunning = true;
      try {
        const byRecent = (a, b) => (b.lastMessageAt?.toMillis?.() || 0) - (a.lastMessageAt?.toMillis?.() || 0);
        const jobs = [
          ...[...contacts].sort(byRecent).slice(0, 20).map(c => ({ key: 'c_' + c.uid, path: ["chats", chatIdFor(c.uid), "messages"] })),
          ...[...groups].sort(byRecent).slice(0, 10).map(g => ({ key: 'g_' + g.id, path: ["groups", g.id, "messages"] }))
        ].filter(x => !prefetchedChats.has(x.key));
        for (const job of jobs) {
          prefetchedChats.add(job.key);
          try {
            await getDocs(query(collection(db, ...job.path), orderBy("createdAt", "desc"), limit(200)));
          } catch (_) { prefetchedChats.delete(job.key); }
          if (!navigator.onLine) break;
        }
      } finally { prefetchRunning = false; }
    }

    function listenToGroups() {
      const q = query(collection(db, "groups"), where("members", "array-contains", currentUserData.uid));
      unsubGroups = onSnapshot(q, (snap) => {
        groups = [];
        snap.forEach(d => groups.push({ id: d.id, ...d.data() }));
        renderGroupsList();
        tryAutoOpenChatFromUrl('groups');
        prefetchRecentChats();
      });
    }

    function renderGroupsList() {
      // Groups now render inside the unified renderChatsList() below —
      // this just triggers a re-render so group updates (rename, new
      // message, etc.) reflect immediately in the combined list.
      renderChatsList();
    }

    // ---------- Create Group modal ----------
    window.openCreateGroup = function () {
      groupAvatarSelection = '👥';
      groupSelectedMemberIds = new Set();
      groupSelectedMemberInfo = {};

      const avatarPicker = document.getElementById('group-avatar-picker');
      const groupEmojis = ['👥', '🎉', '🔥', '⚽', '🎮', '📚', '🎵', '💼', '🍕', '✈️', '🏠', '💡', '🎬', '⭐', '🌍', '❤️'];
      avatarPicker.innerHTML = groupEmojis.map(a => `
        <button onclick="selectGroupAvatar('${a}')" data-group-avatar="${a}"
          class="group-avatar-option w-9 h-9 rounded-xl flex items-center justify-center text-xl ${a === groupAvatarSelection ? 'bg-blue-600' : 'bg-gray-800'}">
          ${a}
        </button>
      `).join('');

      const contactsPicker = document.getElementById('group-contacts-picker');
      if (contacts.length === 0) {
        contactsPicker.innerHTML = `<p class="text-xs text-gray-500">No contacts yet — add people first, or add by app number below.</p>`;
      } else {
        contactsPicker.innerHTML = contacts.map(c => `
          <label class="flex items-center gap-2 p-2 hover:bg-gray-800 rounded-xl cursor-pointer">
            <input type="checkbox" data-contact-uid="${c.uid}" onchange="toggleGroupContact('${c.uid}', this.checked)" class="w-4 h-4">
            <div class="w-7 h-7 bg-gray-700 rounded-lg flex items-center justify-center text-sm shrink-0">${c.avatar || '👤'}</div>
            <span class="text-sm truncate">${escapeHtml(c.displayName)}</span>
          </label>
        `).join('');
      }

      document.getElementById('group-name-input').value = '';
      document.getElementById('group-add-by-number').value = '';
      document.getElementById('create-group-error').classList.add('hidden');
      renderGroupSelectedMembers();

      const modal = document.getElementById('create-group-modal');
      modal.classList.remove('hidden');
    };

    window.closeCreateGroup = function () {
      document.getElementById('create-group-modal').classList.add('hidden');
    };

    window.selectGroupAvatar = function (avatar) {
      groupAvatarSelection = avatar;
      document.querySelectorAll('.group-avatar-option').forEach(btn => {
        btn.classList.toggle('bg-blue-600', btn.dataset.groupAvatar === avatar);
        btn.classList.toggle('bg-gray-800', btn.dataset.groupAvatar !== avatar);
      });
    };

    window.toggleGroupContact = function (uid, checked) {
      const c = contacts.find(x => x.uid === uid);
      if (!c) return;
      if (checked) {
        groupSelectedMemberIds.add(uid);
        groupSelectedMemberInfo[uid] = { displayName: c.displayName, avatar: c.avatar, appNumber: c.appNumber };
      } else {
        groupSelectedMemberIds.delete(uid);
        delete groupSelectedMemberInfo[uid];
      }
      renderGroupSelectedMembers();
    };

    window.handleGroupAddByNumber = async function () {
      const input = document.getElementById('group-add-by-number');
      const num = input.value.trim();
      if (!num) return;
      const q = query(collection(db, "users"), where("appNumber", "==", num));
      const snap = await getDocs(q);
      if (snap.empty) {
        const err = document.getElementById('create-group-error');
        err.textContent = 'No user found with that app number.';
        err.classList.remove('hidden');
        return;
      }
      const found = snap.docs[0].data();
      if (found.uid === currentUserData.uid) return;
      groupSelectedMemberIds.add(found.uid);
      groupSelectedMemberInfo[found.uid] = { displayName: found.displayName, avatar: found.avatar, appNumber: found.appNumber };
      input.value = '';
      document.getElementById('create-group-error').classList.add('hidden');
      renderGroupSelectedMembers();
    };

    function renderGroupSelectedMembers() {
      const container = document.getElementById('group-selected-members');
      const ids = Array.from(groupSelectedMemberIds);
      if (ids.length === 0) {
        container.innerHTML = `<p class="text-xs text-gray-500">No members added yet.</p>`;
        return;
      }
      container.innerHTML = ids.map(uid => {
        const info = groupSelectedMemberInfo[uid] || {};
        return `
          <span class="flex items-center gap-1.5 bg-gray-800 rounded-full pl-2 pr-1 py-1 text-xs">
            ${info.avatar || '👤'} ${escapeHtml(info.displayName || 'User')}
            <button onclick="removeGroupSelectedMember('${uid}')" class="text-gray-400 hover:text-red-400 w-4 h-4 flex items-center justify-center">
              <i class="fas fa-times text-[10px]"></i>
            </button>
          </span>
        `;
      }).join('');
    }

    window.removeGroupSelectedMember = function (uid) {
      groupSelectedMemberIds.delete(uid);
      delete groupSelectedMemberInfo[uid];
      const checkbox = document.querySelector(`input[data-contact-uid="${uid}"]`);
      if (checkbox) checkbox.checked = false;
      renderGroupSelectedMembers();
    };

    window.createGroup = async function () {
      const errEl = document.getElementById('create-group-error');
      errEl.classList.add('hidden');
      const name = document.getElementById('group-name-input').value.trim();

      if (!name) {
        errEl.textContent = 'Give your group a name.';
        errEl.classList.remove('hidden');
        return;
      }
      if (groupSelectedMemberIds.size === 0) {
        errEl.textContent = 'Add at least one member.';
        errEl.classList.remove('hidden');
        return;
      }

      const memberIds = Array.from(groupSelectedMemberIds);
      const memberInfo = { [currentUserData.uid]: { displayName: currentUserData.displayName, avatar: currentUserData.avatar || '👤' } };
      memberIds.forEach(uid => {
        const info = groupSelectedMemberInfo[uid] || {};
        memberInfo[uid] = { displayName: info.displayName || 'User', avatar: info.avatar || '👤' };
      });

      try {
        const groupRef = await addDoc(collection(db, "groups"), {
          name,
          avatar: groupAvatarSelection,
          createdBy: currentUserData.uid,
          admins: [currentUserData.uid],
          members: [currentUserData.uid, ...memberIds],
          memberInfo,
          createdAt: serverTimestamp()
        });
        closeCreateGroup();
        // Give Firestore's listener a beat to populate `groups`, then open it.
        setTimeout(() => openGroupChat(groupRef.id), 400);
      } catch (err) {
        errEl.textContent = 'Could not create group — try again.';
        errEl.classList.remove('hidden');
        console.error(err);
      }
    };

    // ---------- Group info / manage ----------
    window.handleChatHeaderClick = function () {
      if (activeChatType === 'group' && activeGroup) {
        openGroupInfo();
      }
      // For 1-on-1 contacts, header click currently does nothing extra —
      // call buttons already sit to the right for that.
    };

    window.openGroupInfo = function () {
      if (!activeGroup) return;
      const isAdmin = (activeGroup.admins || []).includes(currentUserData.uid);

      document.getElementById('group-info-avatar').textContent = activeGroup.avatar || '👥';
      document.getElementById('group-info-name').textContent = activeGroup.name;
      document.getElementById('group-info-count').textContent = `${activeGroup.members.length} member${activeGroup.members.length === 1 ? '' : 's'}`;
      document.getElementById('group-rename-input').value = activeGroup.name;
      document.getElementById('group-info-error').classList.add('hidden');

      document.getElementById('group-info-rename-section').classList.toggle('hidden', !isAdmin);
      document.getElementById('group-info-add-section').classList.toggle('hidden', !isAdmin);

      const membersList = document.getElementById('group-info-members-list');
      const memberInfo = activeGroup.memberInfo || {};
      membersList.innerHTML = activeGroup.members.map(uid => {
        const info = memberInfo[uid] || { displayName: 'User', avatar: '👤' };
        const memberIsAdmin = (activeGroup.admins || []).includes(uid);
        const isMe = uid === currentUserData.uid;
        return `
          <div class="flex items-center gap-3 p-2 rounded-xl">
            <div class="w-8 h-8 bg-gray-700 rounded-xl flex items-center justify-center text-lg shrink-0">${info.avatar || '👤'}</div>
            <div class="flex-1 min-w-0">
              <p class="text-sm truncate">${escapeHtml(info.displayName)}${isMe ? ' (You)' : ''}</p>
              ${memberIsAdmin ? '<p class="text-[11px] text-amber-400">Admin</p>' : ''}
            </div>
            ${isAdmin && !isMe ? `
              <div class="flex gap-2 shrink-0">
                ${!memberIsAdmin ? `<button onclick="promoteToAdmin('${uid}')" class="text-[11px] text-blue-400 hover:text-blue-300">Make admin</button>` : ''}
                <button onclick="removeGroupMember('${uid}')" class="text-[11px] text-red-400 hover:text-red-300">Remove</button>
              </div>
            ` : ''}
          </div>
        `;
      }).join('');

      document.getElementById('group-info-modal').classList.remove('hidden');
    };

    window.closeGroupInfo = function () {
      document.getElementById('group-info-modal').classList.add('hidden');
    };

    window.handleRenameGroup = async function () {
      if (!activeGroup) return;
      const newName = document.getElementById('group-rename-input').value.trim();
      const errEl = document.getElementById('group-info-error');
      if (!newName) {
        errEl.textContent = 'Group name cannot be empty.';
        errEl.classList.remove('hidden');
        return;
      }
      await updateDoc(doc(db, "groups", activeGroup.id), { name: newName });
      document.getElementById('chat-name').textContent = newName;
      document.getElementById('group-info-name').textContent = newName;
      errEl.classList.add('hidden');
    };

    window.handleAddMemberToExistingGroup = async function () {
      if (!activeGroup) return;
      const input = document.getElementById('group-info-add-number');
      const num = input.value.trim();
      const errEl = document.getElementById('group-info-error');
      if (!num) return;

      const q = query(collection(db, "users"), where("appNumber", "==", num));
      const snap = await getDocs(q);
      if (snap.empty) {
        errEl.textContent = 'No user found with that app number.';
        errEl.classList.remove('hidden');
        return;
      }
      const found = snap.docs[0].data();
      if (activeGroup.members.includes(found.uid)) {
        errEl.textContent = 'Already a member.';
        errEl.classList.remove('hidden');
        return;
      }

      const newMemberInfo = { ...(activeGroup.memberInfo || {}), [found.uid]: { displayName: found.displayName, avatar: found.avatar || '👤' } };
      await updateDoc(doc(db, "groups", activeGroup.id), {
        members: [...activeGroup.members, found.uid],
        memberInfo: newMemberInfo
      });
      activeGroup.members = [...activeGroup.members, found.uid];
      activeGroup.memberInfo = newMemberInfo;
      input.value = '';
      errEl.classList.add('hidden');
      openGroupInfo();
    };

    window.promoteToAdmin = async function (uid) {
      if (!activeGroup) return;
      const newAdmins = Array.from(new Set([...(activeGroup.admins || []), uid]));
      await updateDoc(doc(db, "groups", activeGroup.id), { admins: newAdmins });
      activeGroup.admins = newAdmins;
      openGroupInfo();
    };

    window.removeGroupMember = async function (uid) {
      if (!activeGroup) return;
      if (!confirm('Remove this member from the group?')) return;
      const newMembers = activeGroup.members.filter(m => m !== uid);
      const newAdmins = (activeGroup.admins || []).filter(a => a !== uid);
      await updateDoc(doc(db, "groups", activeGroup.id), { members: newMembers, admins: newAdmins });
      activeGroup.members = newMembers;
      activeGroup.admins = newAdmins;
      openGroupInfo();
    };

    window.leaveGroup = async function () {
      if (!activeGroup) return;
      if (!confirm(`Leave "${activeGroup.name}"?`)) return;
      const newMembers = activeGroup.members.filter(m => m !== currentUserData.uid);
      const newAdmins = (activeGroup.admins || []).filter(a => a !== currentUserData.uid);
      await updateDoc(doc(db, "groups", activeGroup.id), { members: newMembers, admins: newAdmins });
      closeGroupInfo();
      activeGroup = null;
      activeChatType = 'contact';
      document.getElementById('chat-name').textContent = 'Select a chat';
      document.getElementById('chat-status').textContent = '';
      document.getElementById('chat-avatar').textContent = '';
      document.getElementById('message-input').disabled = true;
      document.getElementById('messages').innerHTML = '';
      if (unsubMessages) { unsubMessages(); unsubMessages = null; }
    };

    function chatIdFor(otherUid) {
      return [currentUserData.uid, otherUid].sort().join("_");
    }

    // ---------- Contacts (accepted) ----------
    function listenToContacts() {
      const q = query(collection(db, "users", currentUserData.uid, "contacts"), where("status", "==", "accepted"));
      unsubContacts = onSnapshot(q, (snap) => {
        contacts = [];
        snap.forEach(d => contacts.push(d.data()));
        renderChatsList();
        renderContactsPanel();
        watchContactsForNewMessages();
        watchContactStatuses();
        tryAutoOpenChatFromUrl('contacts');
        prefetchRecentChats();
      });
    }

    // ---------- URL chat route auto-open ----------
    // e.g. app.html?type=contact&uid=XYZ or app.html?type=group&id=XYZ.
    // Contacts and groups load asynchronously and independently, so this is
    // called after each finishes and only acts once (and only for the type
    // it's actually able to satisfy right now).
    let autoOpenedChatFromUrl = false;
    let contactsLoadedOnce = false;
    let groupsLoadedOnce = false;
    function tryAutoOpenChatFromUrl(source) {
      if (!IS_CHAT_PAGE || autoOpenedChatFromUrl) return;
      if (source === 'contacts') contactsLoadedOnce = true;
      if (source === 'groups') groupsLoadedOnce = true;

      const params = new URLSearchParams(location.search);
      const type = params.get('type');
      if (type === 'contact') {
        const uid = params.get('uid');
        if (uid && contacts.some(c => c.uid === uid)) {
          autoOpenedChatFromUrl = true;
          openChatWith(uid);
          return;
        }
      } else if (type === 'group') {
        const id = params.get('id');
        if (id && groups.some(g => g.id === id)) {
          autoOpenedChatFromUrl = true;
          openGroupChat(id);
          return;
        }
      }

      // Both sources have reported in and we still couldn't find the chat
      // this URL points to (bad link, removed contact, left group) — don't
      // strand the user on a blank chat screen.
      if (!type || (contactsLoadedOnce && groupsLoadedOnce)) {
        autoOpenedChatFromUrl = true;
        goToChatList();
      }
    }

    // Helper: get a comparable millisecond timestamp from a Firestore
    // Timestamp, falling back to 0 (sorts to the bottom) if unset/pending.
    function toMillis(ts) {
      if (!ts) return 0;
      if (typeof ts.toMillis === 'function') return ts.toMillis();
      if (typeof ts.seconds === 'number') return ts.seconds * 1000;
      return 0;
    }

    function renderChatsList() {
      const container = document.getElementById('chats-list');

      const contactItems = contacts.map(c => ({
        type: 'contact',
        id: c.uid,
        sortTime: toMillis(c.lastMessageAt) || toMillis(c.createdAt),
        data: c
      }));
      const groupItems = groups.map(g => ({
        type: 'group',
        id: g.id,
        sortTime: toMillis(g.lastMessageAt) || toMillis(g.createdAt),
        data: g
      }));

      const combined = [...contactItems, ...groupItems].sort((a, b) => b.sortTime - a.sortTime);

      if (combined.length === 0) {
        container.innerHTML = `<p class="text-gray-500 text-sm text-center mt-4 px-2">No chats yet. Use "Add" to find someone by their app number, or start a group.</p>`;
        return;
      }

      container.innerHTML = combined.map(item => {
        if (item.type === 'group') {
          const g = item.data;
          const isActive = activeChatType === 'group' && activeGroup && activeGroup.id === g.id;
          const unread = (g.unreadCounts && g.unreadCounts[currentUserData.uid]) || 0;
          const badge = unread > 0 ? `<span class="shrink-0 bg-blue-600 text-white text-[11px] font-semibold min-w-[20px] h-5 px-1.5 rounded-full flex items-center justify-center">${unread > 99 ? '99+' : unread}</span>` : '';
          return `
            <div class="flex items-center gap-3 p-3 hover:bg-gray-800 rounded-2xl cursor-pointer ${isActive ? 'bg-gray-800' : ''}" onclick="openGroupChat('${g.id}')">
              <div class="w-10 h-10 bg-gray-700 rounded-2xl flex items-center justify-center text-2xl shrink-0">${g.avatar || '👥'}</div>
              <div class="flex-1 min-w-0">
                <p class="font-medium truncate">${escapeHtml(g.name)}</p>
                <p class="text-xs text-gray-400 truncate">${g.lastMessageText ? escapeHtml(g.lastMessageText) : `${g.members.length} member${g.members.length === 1 ? '' : 's'}`}</p>
              </div>
              ${badge}
            </div>
          `;
        } else {
          const c = item.data;
          const isActive = activeChatType === 'contact' && activeChatUser && activeChatUser.uid === c.uid;
          const unread = c.unreadCount || 0;
          const badge = unread > 0 ? `<span class="shrink-0 bg-blue-600 text-white text-[11px] font-semibold min-w-[20px] h-5 px-1.5 rounded-full flex items-center justify-center">${unread > 99 ? '99+' : unread}</span>` : '';
          return `
            <div class="relative flex items-center gap-3 p-3 hover:bg-gray-800 rounded-2xl cursor-pointer ${isActive ? 'bg-gray-800' : ''}" onclick="openChatWith('${c.uid}')">
              <div class="relative shrink-0">
                <div class="w-10 h-10 bg-gray-700 rounded-2xl flex items-center justify-center text-2xl">${c.avatar || '👤'}</div>
                <span id="dot-${c.uid}" class="hidden absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 border-2 border-gray-900 rounded-full"></span>
              </div>
              <div class="flex-1 min-w-0">
                <p class="font-medium truncate">${escapeHtml(c.displayName)}</p>
                <p class="text-xs text-gray-400 truncate">${c.lastMessageText ? escapeHtml(c.lastMessageText) : c.appNumber}</p>
              </div>
              ${badge}
            </div>
          `;
        }
      }).join('');

      // Attach a live presence listener per contact ONLY once — re-rendering
      // the list (which happens on every new message, etc.) used to attach a
      // fresh onValue listener each time without ever detaching the old one,
      // causing listener buildup and inconsistent/stale online dots.
      contacts.forEach(c => {
        if (chatListPresenceListeners.has(c.uid)) return;
        const unsub = onValue(ref(rtdb, `presence/${c.uid}`), (snap) => {
          const val = snap.val();
          const dot = document.getElementById(`dot-${c.uid}`);
          if (dot) dot.classList.toggle('hidden', !(val && val.online));
        });
        chatListPresenceListeners.set(c.uid, unsub);
      });
      // Clean up listeners for contacts that are no longer in the list (removed, etc.)
      const currentContactIds = new Set(contacts.map(c => c.uid));
      chatListPresenceListeners.forEach((unsub, uid) => {
        if (!currentContactIds.has(uid)) {
          unsub();
          chatListPresenceListeners.delete(uid);
        }
      });
    }

    // ---------- Add by app number ----------
    window.handleFindUser = async function () {
      const input = document.getElementById('add-number-input');
      const resultBox = document.getElementById('add-result');
      const num = input.value.trim();
      if (!num) return;
      resultBox.innerHTML = `<p class="text-gray-500 text-sm text-center mt-4">Searching...</p>`;

      const q = query(collection(db, "users"), where("appNumber", "==", num));
      const snap = await getDocs(q);
      if (snap.empty) {
        resultBox.innerHTML = `<p class="text-gray-500 text-sm text-center mt-4">No user found with that app number.</p>`;
        return;
      }
      const found = snap.docs[0].data();
      if (found.uid === currentUserData.uid) {
        resultBox.innerHTML = `<p class="text-gray-500 text-sm text-center mt-4">That's your own number 🙂</p>`;
        return;
      }

      const contactRef = doc(db, "users", currentUserData.uid, "contacts", found.uid);
      const existing = await getDoc(contactRef);
      let statusLine = '';
      if (existing.exists()) {
        const st = existing.data().status;
        if (st === 'accepted') statusLine = `<p class="text-green-400 text-xs mt-2">Already in your contacts.</p>`;
        else if (st === 'pending_sent') statusLine = `<p class="text-amber-400 text-xs mt-2">Request already sent, waiting for them to accept.</p>`;
        else if (st === 'pending_received') statusLine = `<p class="text-blue-400 text-xs mt-2">They already sent you a request — check Requests in the "+" menu.</p>`;
      }

      resultBox.innerHTML = `
        <div class="flex items-center gap-3 p-3 bg-gray-800 rounded-2xl mb-3">
          <div class="w-10 h-10 bg-gray-700 rounded-2xl flex items-center justify-center text-2xl shrink-0">${found.avatar || '👤'}</div>
          <div class="flex-1 min-w-0">
            <p class="font-medium truncate">${escapeHtml(found.displayName)}</p>
            <p class="text-xs text-gray-400">${found.appNumber}</p>
          </div>
        </div>
        ${statusLine}
        ${(!existing.exists()) ? `
          <textarea id="first-message" rows="2" placeholder="Say why you're reaching out (this is your one message until they accept)"
            class="w-full bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 mb-2"></textarea>
          <button onclick="sendContactRequest('${found.uid}')" class="w-full py-3 bg-blue-600 hover:bg-blue-700 rounded-2xl text-sm font-medium">Send Request</button>
        ` : ''}
      `;
    };

    window.sendContactRequest = async function (targetUid, msgElementId) {
      if (contacts.length >= MAX_CONTACTS) {
        alert(`You've reached the ${MAX_CONTACTS} contact limit. Remove someone before adding a new contact.`);
        return;
      }
      // A request only counts once the server has it. Without a connection we say so instead of
      // pretending it was sent (the other person would never see it).
      if (!isServerReachable()) {
        alert("You're not connected yet, so the request can't be delivered. Wait for the green 'Connected' bar and try again.");
        return;
      }

      const msgEl = document.getElementById(msgElementId || 'first-message');
      const resultBox = document.getElementById('add-result');
      const isAddPanel = msgEl === document.getElementById('first-message');
      if (isAddPanel && resultBox) resultBox.innerHTML = `<p class="text-gray-400 text-sm text-center mt-4">Sending…</p>`;

      try {
        const targetSnap = await getDoc(doc(db, "users", targetUid));
        if (!targetSnap.exists()) throw new Error('User not found');
        const target = targetSnap.data();
        const msgText = (msgEl?.value || '').trim();

        // Both entries are written together: either both arrive or neither does.
        const batch = writeBatch(db);
        batch.set(doc(db, "users", currentUserData.uid, "contacts", targetUid), {
          uid: targetUid, displayName: target.displayName, appNumber: target.appNumber,
          avatar: target.avatar || '👤', status: 'pending_sent', createdAt: serverTimestamp()
        });
        batch.set(doc(db, "users", targetUid, "contacts", currentUserData.uid), {
          uid: currentUserData.uid, displayName: currentUserData.displayName, appNumber: currentUserData.appNumber,
          avatar: currentUserData.avatar || '👤', status: 'pending_received', createdAt: serverTimestamp()
        });
        // Wait for the server to confirm (not just the phone's saved copy), but don't hang forever.
        await Promise.race([
          batch.commit(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))
        ]);

        if (msgText) {
          await addDoc(collection(db, "chats", chatIdFor(targetUid), "messages"), {
            text: msgText, senderId: currentUserData.uid, recipientId: targetUid, createdAt: serverTimestamp()
          });
        }
        if (isAddPanel && resultBox) {
          resultBox.innerHTML = `<p class="text-green-400 text-sm text-center mt-4">Request delivered ✅</p>`;
          document.getElementById('add-number-input').value = '';
        }
      } catch (e) {
        console.error('Request failed:', e);
        const msg = e.message === 'timeout'
          ? "Couldn't confirm delivery (weak network). Check Contacts → 'Requests you sent' and tap Resend when you're connected."
          : "Could not send the request. Check your connection and try again.";
        if (isAddPanel && resultBox) resultBox.innerHTML = `<p class="text-red-400 text-sm text-center mt-4">${escapeHtml(msg)}</p>`;
        else alert(msg);
        throw e;
      }
    };

    // ---------- Contacts list (in the "+" menu) + requests I sent ----------
    let sentRequests = [];
    let unsubSentRequests = null;
    function listenToSentRequests() {
      if (unsubSentRequests) unsubSentRequests();
      const q = query(collection(db, "users", currentUserData.uid, "contacts"), where("status", "==", "pending_sent"));
      unsubSentRequests = onSnapshot(q, (snap) => {
        sentRequests = [];
        snap.forEach(d => sentRequests.push(d.data()));
        renderContactsPanel();
      });
    }

    function renderContactsPanel() {
      const list = document.getElementById('contacts-list');
      if (!list) return;
      const sorted = contacts.slice().sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
      list.innerHTML = sorted.length === 0
        ? `<p class="text-gray-500 text-sm text-center mt-6">No contacts yet. Use Add to find someone by their app number.</p>`
        : sorted.map(c => `
          <button onclick="closePlusPanel(); openChatWith('${c.uid}')" class="w-full flex items-center gap-3 p-3 hover:bg-gray-800 rounded-2xl text-left">
            <div class="w-11 h-11 bg-gray-700 rounded-2xl flex items-center justify-center text-2xl shrink-0">${escapeHtml(c.avatar || '👤')}</div>
            <div class="min-w-0 flex-1">
              <p class="font-medium truncate">${escapeHtml(c.displayName || 'User')}</p>
              <p class="text-xs text-gray-400 truncate">${escapeHtml(c.appNumber || '')}</p>
            </div>
            <i class="fas fa-comment text-blue-400"></i>
          </button>`).join('');

      const block = document.getElementById('sent-requests-block');
      const sentList = document.getElementById('sent-requests-list');
      block.classList.toggle('hidden', sentRequests.length === 0);
      sentList.innerHTML = sentRequests.map(r => `
        <div class="flex items-center gap-3 p-3 bg-gray-800 rounded-2xl">
          <div class="w-10 h-10 bg-gray-700 rounded-2xl flex items-center justify-center text-xl shrink-0">${escapeHtml(r.avatar || '👤')}</div>
          <div class="min-w-0 flex-1">
            <p class="font-medium truncate">${escapeHtml(r.displayName || 'User')}</p>
            <p class="text-xs text-amber-400">Waiting for them to accept</p>
          </div>
          <button onclick="resendRequest('${r.uid}')" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-xs font-medium">Resend</button>
          <button onclick="cancelSentRequest('${r.uid}')" class="px-2 py-1.5 text-gray-400 hover:text-red-400 text-xs">Cancel</button>
        </div>`).join('');
    }

    // Re-deliver a request that may never have reached the other person. If their copy already exists
    // the rules refuse the write, which just means it was delivered after all.
    window.resendRequest = async function (uid) {
      if (!isServerReachable()) { alert("You're not connected yet. Wait for the green 'Connected' bar and try again."); return; }
      try {
        await setDoc(doc(db, "users", uid, "contacts", currentUserData.uid), {
          uid: currentUserData.uid, displayName: currentUserData.displayName, appNumber: currentUserData.appNumber,
          avatar: currentUserData.avatar || '👤', status: 'pending_received', createdAt: serverTimestamp()
        });
        alert('Request sent again ✅');
      } catch (e) {
        alert('Their phone already has your request. They need to accept it.');
      }
    };
    window.cancelSentRequest = async function (uid) {
      if (!confirm('Cancel this request?')) return;
      await deleteDoc(doc(db, "users", currentUserData.uid, "contacts", uid)).catch(() => {});
      await deleteDoc(doc(db, "users", uid, "contacts", currentUserData.uid)).catch(() => {});
    };

    // ---------- Discover: browse people by self-entered region ----------
    window.handleDiscoverSearch = async function () {
      const listEl = document.getElementById('discover-list');
      const regionInput = document.getElementById('discover-region-input');
      const professionInput = document.getElementById('discover-profession-input');
      const typedRegion = regionInput.value.trim().toLowerCase();
      const typedProfession = (professionInput ? professionInput.value.trim().toLowerCase() : '');

      listEl.innerHTML = `<p class="text-gray-500 text-sm text-center mt-4">Loading people...</p>`;

      const snap = await getDocs(collection(db, "users"));
      const results = [];
      snap.forEach(d => {
        const u = d.data();
        if (u.uid === currentUserData.uid) return;

        // No filters entered → show everyone (open directory, not just region matches).
        if (!typedRegion && !typedProfession) {
          results.push(u);
          return;
        }

        const regionMatch = typedRegion && u.region && u.region.toLowerCase().includes(typedRegion);
        const professionMatch = typedProfession && u.profession && u.profession.toLowerCase().includes(typedProfession);

        if (regionMatch || professionMatch) results.push(u);
      });

      if (results.length === 0) {
        listEl.innerHTML = `<p class="text-gray-500 text-sm text-center mt-8 px-2">No one found. Be the first to invite friends here!</p>`;
        return;
      }

      // Check existing contact status for each result
      const withStatus = await Promise.all(results.map(async (u) => {
        const cSnap = await getDoc(doc(db, "users", currentUserData.uid, "contacts", u.uid));
        return { user: u, status: cSnap.exists() ? cSnap.data().status : null };
      }));

      listEl.innerHTML = withStatus.map(({ user, status }) => {
        let actionHtml = '';
        if (status === 'accepted') {
          actionHtml = `<span class="text-xs text-green-400">In your contacts</span>`;
        } else if (status === 'pending_sent') {
          actionHtml = `<span class="text-xs text-amber-400">Request sent</span>`;
        } else if (status === 'pending_received') {
          actionHtml = `<span class="text-xs text-blue-400">Check Requests</span>`;
        } else {
          actionHtml = `<button onclick="openDiscoverRequest('${user.uid}')" class="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded-xl font-medium">Add</button>`;
        }
        const subtitleParts = [];
        if (user.profession) subtitleParts.push(escapeHtml(user.profession));
        if (user.region) subtitleParts.push(escapeHtml(user.region));
        return `
          <div id="discover-row-${user.uid}" class="p-3 bg-gray-800 rounded-2xl">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 bg-gray-700 rounded-2xl flex items-center justify-center text-2xl shrink-0">${user.avatar || '👤'}</div>
              <div class="flex-1 min-w-0">
                <p class="font-medium truncate">${escapeHtml(user.displayName)}</p>
                <p class="text-xs text-gray-400 truncate">${subtitleParts.join(' · ') || 'PrivateChat user'}</p>
              </div>
              ${actionHtml}
            </div>
            <div id="discover-request-box-${user.uid}"></div>
          </div>
        `;
      }).join('');
    };

    window.openDiscoverRequest = function (targetUid) {
      const box = document.getElementById(`discover-request-box-${targetUid}`);
      if (!box) return;
      box.innerHTML = `
        <textarea id="discover-msg-${targetUid}" rows="2" placeholder="Say hello (your one message until they accept)"
          class="w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 mt-3 mb-2"></textarea>
        <button onclick="sendDiscoverRequest('${targetUid}')" class="w-full py-2.5 bg-blue-600 hover:bg-blue-700 rounded-xl text-sm font-medium">Send Request</button>
      `;
    };

    window.sendDiscoverRequest = async function (targetUid) {
      await sendContactRequest(targetUid, `discover-msg-${targetUid}`);
      const row = document.getElementById(`discover-row-${targetUid}`);
      if (row) row.innerHTML = `<p class="text-green-400 text-sm text-center py-2">Request sent ✅</p>`;
    };

    // ---------- Incoming requests ----------
    function listenToIncomingRequests() {
      const q = query(collection(db, "users", currentUserData.uid, "contacts"), where("status", "==", "pending_received"));
      unsubIncoming = onSnapshot(q, (snap) => {
        incomingRequests = [];
        snap.forEach(d => incomingRequests.push(d.data()));
        renderRequestsList();
        const count = incomingRequests.length;
        [
          { id: 'requests-badge', display: 'flex' },
          { id: 'requests-badge-menu', display: 'flex' },
          { id: 'requests-badge-panel', display: 'flex' }
        ].forEach(({ id, display }) => {
          const badge = document.getElementById(id);
          if (!badge) return;
          if (count > 0) {
            badge.textContent = count;
            badge.classList.remove('hidden');
            badge.classList.add(display);
          } else {
            badge.classList.add('hidden');
            badge.classList.remove(display);
          }
        });
      });
    }

    async function renderRequestsList() {
      const container = document.getElementById('requests-list');
      if (incomingRequests.length === 0) {
        container.innerHTML = `<p class="text-gray-500 text-sm text-center mt-8">No pending requests.</p>`;
        return;
      }
      const blocks = await Promise.all(incomingRequests.map(async (r) => {
        const chatId = chatIdFor(r.uid);
        const msgsSnap = await getDocs(query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "asc"), limit(1)));
        let preview = '';
        if (!msgsSnap.empty) preview = escapeHtml(msgsSnap.docs[0].data().text);
        return `
          <div class="p-3 bg-gray-800 rounded-2xl">
            <div class="flex items-center gap-3 mb-2">
              <div class="w-10 h-10 bg-gray-700 rounded-2xl flex items-center justify-center text-2xl shrink-0">${r.avatar || '👤'}</div>
              <div class="flex-1 min-w-0">
                <p class="font-medium truncate">${escapeHtml(r.displayName)}</p>
                <p class="text-xs text-gray-400">${r.appNumber}</p>
              </div>
            </div>
            ${preview ? `<p class="text-sm text-gray-300 bg-gray-900 rounded-xl p-2 mb-2 italic">"${preview}"</p>` : ''}
            <div class="flex gap-2">
              <button onclick="acceptRequest('${r.uid}')" class="flex-1 py-2 bg-green-600 hover:bg-green-700 rounded-xl text-sm font-medium">Accept</button>
              <button onclick="declineRequest('${r.uid}')" class="flex-1 py-2 bg-gray-700 hover:bg-gray-600 rounded-xl text-sm font-medium">Decline</button>
            </div>
          </div>
        `;
      }));
      container.innerHTML = blocks.join('');
    }

    window.acceptRequest = async function (otherUid) {
      if (contacts.length >= MAX_CONTACTS) {
        alert(`You've reached the ${MAX_CONTACTS} contact limit. Remove someone before accepting new requests.`);
        return;
      }
      await updateDoc(doc(db, "users", currentUserData.uid, "contacts", otherUid), { status: 'accepted' });
      await updateDoc(doc(db, "users", otherUid, "contacts", currentUserData.uid), { status: 'accepted' });
    };

    window.declineRequest = async function (otherUid) {
      await deleteDoc(doc(db, "users", currentUserData.uid, "contacts", otherUid));
      await deleteDoc(doc(db, "users", otherUid, "contacts", currentUserData.uid));
    };

    // ---------- Notifications for new incoming messages while app open ----------
    function watchContactsForNewMessages() {
      contacts.forEach(c => {
        if (unsubGlobalMsgWatchers[c.uid]) return;
        const chatId = chatIdFor(c.uid);
        const q = query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "desc"), limit(1));
        let firstLoad = true;
        unsubGlobalMsgWatchers[c.uid] = onSnapshot(q, (snap) => {
          if (firstLoad) { firstLoad = false; return; }
          if (snap.empty) return;
          const msg = snap.docs[0].data();
          if (msg.senderId === currentUserData.uid) return;
          const isViewingThisChat = activeChatUser && activeChatUser.uid === c.uid;
          if (!isViewingThisChat) {
            showToast(c.displayName, msg.text, c.avatar);
          }
        });
      });
    }

    function showToast(name, text, avatar) {
      const container = document.getElementById('toast-container');
      const el = document.createElement('div');
      el.className = 'pointer-events-auto bg-gray-800 border border-gray-700 rounded-2xl p-3 shadow-2xl flex items-center gap-3';
      el.style.opacity = '0'; el.style.transition = 'opacity 0.2s';
      el.innerHTML = `
        <div class="w-9 h-9 bg-gray-700 rounded-xl flex items-center justify-center text-xl shrink-0">${avatar || '👤'}</div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold truncate">${escapeHtml(name)}</p>
          <p class="text-xs text-gray-400 truncate">${escapeHtml(text)}</p>
        </div>
      `;
      container.appendChild(el);
      requestAnimationFrame(() => { el.style.opacity = '1'; });
      setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4000);
    }

    // Tab indices: 0 Chats, 1 (unused, was Add — now inside "+" panel),
    // 2 Admin, 3 (unused, was Requests — now inside "+" panel),
    // 4 Discover, 5 Status, 6 Calls.
    window.switchTab = function (n) {
      closeChatsPlusMenu();
      document.getElementById('chats-tab').classList.toggle('hidden', n !== 0);
      document.getElementById('plus-panel').classList.add('hidden'); // always closed when switching main tabs
      document.getElementById('admin-tab').classList.toggle('hidden', n !== 2);
      document.getElementById('settings-tab').classList.toggle('hidden', n !== 7);
      const bell = document.getElementById('reminders-bell-btn');
      if (bell) bell.classList.toggle('hidden', n === 7);
      document.getElementById('feed-tab').classList.toggle('hidden', n !== 8);
      document.getElementById('discover-tab').classList.toggle('hidden', n !== 4);
      document.getElementById('status-tab').classList.toggle('hidden', n !== 5);
      document.getElementById('calls-tab').classList.toggle('hidden', n !== 6);

      const adminSubtabs = document.getElementById('admin-subtabs');
      if (adminSubtabs) adminSubtabs.classList.toggle('hidden', n !== 2);

      const bottomBtns = {
        0: document.getElementById('bottomnav-chats'),
        5: document.getElementById('bottomnav-status'),
        6: document.getElementById('bottomnav-calls'),
        4: document.getElementById('bottomnav-discover'),
        7: document.getElementById('bottomnav-settings'),
        8: document.getElementById('bottomnav-feed')
      };
      Object.values(bottomBtns).forEach(el => { if (el) el.classList.remove('text-blue-400'); el?.classList.add('text-gray-400'); });
      if (bottomBtns[n]) { bottomBtns[n].classList.remove('text-gray-400'); bottomBtns[n].classList.add('text-blue-400'); }

      if (n === 4 && !discoverLoadedOnce) {
        discoverLoadedOnce = true;
        handleDiscoverSearch();
      }
      if (n === 5) {
        renderStatusStrip(); // populate the Status tab's own strip container too
      }
      if (n === 6) {
        renderCallHistory();
      }
      if (n === 7) {
        fillSettingsForm();
      }
      if (n === 8) {
        openFeedTab();
      }
    };

    // ---------- "+" menu on Chats (Add / New Group / Requests) ----------
    window.toggleChatsPlusMenu = function () {
      const menu = document.getElementById('chats-plus-menu');
      menu.classList.toggle('hidden');
    };
    window.closeChatsPlusMenu = function () {
      document.getElementById('chats-plus-menu')?.classList.add('hidden');
    };
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('chats-plus-menu');
      const btn = document.getElementById('chats-plus-btn');
      if (!menu || menu.classList.contains('hidden')) return;
      if (e.target === btn || btn?.contains(e.target)) return;
      if (menu.contains(e.target)) return;
      menu.classList.add('hidden');
    });

    window.openPlusMenuTab = function (which) {
      closeChatsPlusMenu();
      document.getElementById('chats-tab').classList.add('hidden');
      document.getElementById('plus-panel').classList.remove('hidden');
      switchPlusPanelTab(which);
    };
    window.closePlusPanel = function () {
      document.getElementById('plus-panel').classList.add('hidden');
      document.getElementById('chats-tab').classList.remove('hidden');
    };
    window.switchPlusPanelTab = function (which) {
      ['add', 'contacts', 'requests'].forEach(t => {
        document.getElementById(t + '-tab').classList.toggle('hidden', t !== which);
        const btn = document.getElementById('plus-tab-' + t);
        btn.classList.toggle('bg-blue-600', t === which);
        btn.classList.toggle('text-white', t === which);
      });
      if (which === 'contacts') renderContactsPanel();
    };

    window.toggleSidebar = function () {
      // The chat header back arrow always returns to the full landing view.
      if (IS_CHAT_PAGE) {
        goToChatList();
        return;
      }
      const sidebar = document.getElementById('sidebar');
      isSidebarOpen = !isSidebarOpen;
      sidebar.classList.toggle('open', isSidebarOpen);
      // Keep the full-screen chat view (mobile) in sync: sidebar open == chat closed.
      document.getElementById('chat-area')?.classList.toggle('chat-area-active', !isSidebarOpen);
    };

    // ---------- Chat ----------
    let otherUserReadReceiptsEnabled = true; // fetched fresh each time a 1-on-1 chat opens

    window.openChatWith = function (otherUid) {
      const user = contacts.find(c => c.uid === otherUid);
      if (!user) return;

      // Stay on app.html: opening a conversation is an in-page route change.
      if (!IS_CHAT_PAGE) {
        enterChatRoute({ type: 'contact', uid: otherUid });
      }

      activeChatType = 'contact';
      activeChatUser = user;
      activeGroup = null;
      replyingToMessage = null;
      editingMessageId = null;
      renderComposerBanner();

      document.getElementById('chat-avatar').textContent = user.avatar || '👤';
      document.getElementById('chat-name').textContent = user.displayName;
      document.getElementById('chat-status').textContent = user.appNumber;
      document.getElementById('message-input').disabled = false;
      document.getElementById('message-input').value = '';
      const callBtns = document.getElementById('call-buttons');
      callBtns.classList.remove('hidden');
      callBtns.classList.add('flex');

      switchTab(0);
      renderChatsList();
      renderGroupsList();
      watchPresenceFor(user.uid);

      // Clear unread badge for this contact now that I'm viewing the chat.
      if (user.unreadCount) {
        updateDoc(doc(db, "users", currentUserData.uid, "contacts", otherUid), { unreadCount: 0 }).catch(() => {});
      }

      // Read receipts preference can change anytime in Settings, so the
      // stale copy in `contacts` isn't reliable — fetch it fresh.
      otherUserReadReceiptsEnabled = true;
      getDoc(doc(db, "users", otherUid)).then(snap => {
        if (snap.exists()) {
          otherUserReadReceiptsEnabled = snap.data().readReceiptsEnabled !== false;
          renderMessages(currentMessagesCache); // re-render so the read tag reflects it
        }
      }).catch(() => {});

      if (window.innerWidth < 768) {
        document.getElementById('sidebar').classList.remove('open');
        isSidebarOpen = false;
        document.getElementById('chat-area')?.classList.add('chat-area-active');
      }

      listenToMessages();
    };

    window.openGroupChat = function (groupId) {
      const group = groups.find(g => g.id === groupId);
      if (!group) return;

      // Stay on app.html: opening a group is an in-page route change.
      if (!IS_CHAT_PAGE) {
        enterChatRoute({ type: 'group', id: groupId });
      }

      activeChatType = 'group';
      activeGroup = group;
      activeChatUser = null;
      replyingToMessage = null;
      editingMessageId = null;
      renderComposerBanner();

      document.getElementById('chat-avatar').textContent = group.avatar || '👥';
      document.getElementById('chat-name').textContent = group.name;
      document.getElementById('chat-status').textContent = `${group.members.length} member${group.members.length === 1 ? '' : 's'}`;
      document.getElementById('chat-presence-dot').classList.add('hidden');
      document.getElementById('message-input').disabled = false;
      document.getElementById('message-input').value = '';
      // Group chats get group voice/video calls (see GROUP CALLS).
      const callBtns = document.getElementById('call-buttons');
      callBtns.classList.remove('hidden');
      callBtns.classList.add('flex');
      if (unsubPresence) { unsubPresence(); unsubPresence = null; }

      switchTab(0);
      renderChatsList();
      renderGroupsList();

      // Clear my unread badge for this group.
      if (group.unreadCounts && group.unreadCounts[currentUserData.uid]) {
        updateDoc(doc(db, "groups", groupId), {
          [`unreadCounts.${currentUserData.uid}`]: 0
        }).catch(() => {});
      }

      if (window.innerWidth < 768) {
        document.getElementById('sidebar').classList.remove('open');
        isSidebarOpen = false;
        document.getElementById('chat-area')?.classList.add('chat-area-active');
      }

      listenToMessages();
    };

    function listenToMessages() {
      if (unsubMessages) unsubMessages();
      const path = activeChatType === 'group'
        ? ["groups", activeGroup.id, "messages"]
        : ["chats", chatIdFor(activeChatUser.uid), "messages"];
      const q = query(
        collection(db, ...path),
        orderBy("createdAt", "desc"),   // newest 200, then flipped below to oldest-first
        limit(200)
      );
      const listenerChatKey = currentChatKey();
      unsubMessages = onSnapshot(q, (snap) => {
        const messages = [];
        snap.forEach(d => messages.push({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites }));
        messages.reverse();
        currentMessagesChatKey = listenerChatKey;
        renderMessages(messages);
        if (activeChatType === 'contact') markMessagesAsRead(messages);
      });
    }

    // Read receipts (1-on-1 chats only). Scoped this way rather than
    // per-group-member tracking, which is a bigger feature on its own.
    // Respects the Instagram-style trade-off: if I have read receipts
    // turned off, I don't write readAt on messages I read, and the
    // render step below also won't show anyone else's readAt to me.
    async function markMessagesAsRead(messages) {
      if (currentUserData.readReceiptsEnabled === false) return;
      if (!activeChatUser) return;
      const path = ["chats", chatIdFor(activeChatUser.uid), "messages"];
      const toMark = messages.filter(m => m.senderId === activeChatUser.uid && !m.readAt);
      if (toMark.length === 0) return;
      await Promise.all(toMark.map(m =>
        updateDoc(doc(db, ...path, m.id), { readAt: serverTimestamp() }).catch(() => {})
      ));
    }

    function renderMessages(messages) {
      const container = document.getElementById('messages');
      // Remember where the reader is, so a refresh (new message, read receipt, etc.) doesn't yank
      // them back to the bottom while they scroll up through history.
      const prevTop = container.scrollTop;
      const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
      const sameChat = container.dataset.chatKey === String(currentMessagesChatKey);
      const prevCount = Number(container.dataset.count || 0);
      const last = messages[messages.length - 1];
      const iJustSent = !!last && last.senderId === currentUserData.uid && messages.length > prevCount;
      container.dataset.chatKey = String(currentMessagesChatKey);
      container.dataset.count = String(messages.length);
      currentMessagesCache = messages; // used for reply lookups and edit
      const outboxHtml = renderOutboxHtml();
      if (messages.length === 0 && !outboxHtml) {
        container.innerHTML = `<p class="text-gray-600 text-sm text-center mt-8">Say hello 👋</p>`;
        return;
      }
      const myAvatar = currentUserData.avatar || '👤';
      const theirAvatar = (activeChatUser && activeChatUser.avatar) || '👤';
      const isGroup = activeChatType === 'group';

      // Read receipts show only for 1-on-1 chats, only when BOTH people have
      // them enabled, and only on the most recent message I sent that's been read.
      const readReceiptsActive = !isGroup && currentUserData.readReceiptsEnabled !== false && otherUserReadReceiptsEnabled;
      let lastMyReadMsgId = null;
      if (readReceiptsActive) {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].senderId === currentUserData.uid && messages[i].readAt) {
            lastMyReadMsgId = messages[i].id;
            break;
          }
        }
      }

      container.innerHTML = messages.map(msg => {
        const isMe = msg.senderId === currentUserData.uid;
        // Layout is flipped from the usual convention: MY messages render on
        // the LEFT, the other person's render on the RIGHT.
        const onRight = !isMe;
        const isBroadcast = !!msg.isBroadcast;
        const time = msg.createdAt && msg.createdAt.toDate
          ? msg.createdAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '';
        const avatar = isBroadcast ? (msg.senderAvatarOverride || '🛡️') : (isMe ? myAvatar : (isGroup ? (msg.senderAvatar || '👤') : theirAvatar));
        const avatarEl = `<div class="w-8 h-8 bg-gray-700 rounded-xl flex items-center justify-center text-lg shrink-0">${avatar}</div>`;
        // In groups, label every non-me message with the sender's name (like WhatsApp groups).
        const senderLabel = isBroadcast
          ? `<p class="text-[11px] font-semibold text-amber-400 mb-1">${escapeHtml(msg.senderNameOverride || 'PrivateChat Support')}</p>`
          : (isGroup && !isMe ? `<p class="text-[11px] font-semibold text-teal-400 mb-1">${escapeHtml(msg.senderName || 'Member')}</p>` : '');
        const editedTag = msg.edited ? `<span class="opacity-60"> · edited</span>` : '';
        const replyBlock = msg.replyTo ? `
          <div class="mb-1.5 pl-2 border-l-2 border-white/30 opacity-80">
            <p class="text-[11px] font-medium">${escapeHtml(msg.replyTo.senderName)}</p>
            <p class="text-xs truncate max-w-[220px]">${escapeHtml(msg.replyTo.text)}</p>
          </div>
        ` : '';
        const bubbleColor = isBroadcast ? 'bg-amber-900/40 border border-amber-700' : (isMe ? 'bg-blue-600 text-white' : 'bg-gray-800');
        const actionsHtml = isBroadcast ? '' : `
          <div class="flex gap-3 mt-1 ${onRight ? 'justify-end' : 'justify-start'}">
            <button onclick="startReply('${msg.id}')" class="text-[11px] text-gray-500 hover:text-gray-300"><i class="fas fa-reply"></i> Reply</button>
            ${isMe ? `<button onclick="startEdit('${msg.id}')" class="text-[11px] text-gray-500 hover:text-gray-300"><i class="fas fa-pen"></i> Edit</button>` : ''}
            ${isMe ? `<button onclick="deleteMessage('${msg.id}')" class="text-[11px] text-gray-500 hover:text-red-400"><i class="fas fa-trash"></i> Delete</button>` : ''}
          </div>
        `;
        const readTag = (msg.id === lastMyReadMsgId && msg.readAt && msg.readAt.toDate)
          ? `<p class="text-[10px] text-right mt-0.5 text-blue-300">Read at ${msg.readAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>`
          : '';
        const mediaBlock = msg.mediaType ? renderMediaBlock(msg) : '';
        const textBlock = msg.text ? `<p class="text-[15px] leading-relaxed ${msg.mediaType ? 'mt-2' : ''}">${escapeHtml(msg.text)}</p>` : '';
        return `
          <div class="flex flex-col ${onRight ? 'items-end' : 'items-start'}">
            <div class="flex items-end gap-2 ${onRight ? 'justify-end' : 'justify-start'}">
              ${onRight ? '' : avatarEl}
              <div class="message-bubble ${bubbleColor} rounded-3xl px-5 py-3">
                ${senderLabel}
                ${replyBlock}
                ${mediaBlock}
                ${textBlock}
                <p class="text-[10px] text-right mt-1 opacity-70">${time}${editedTag}${msg._pending ? ' <i class="far fa-clock" title="Waiting to send"></i>' : ''}</p>
              </div>
              ${onRight ? avatarEl : ''}
            </div>
            ${readTag}
            ${actionsHtml}
          </div>
        `;
      }).join('') + outboxHtml;
      if (!sameChat || wasNearBottom || iJustSent) container.scrollTop = container.scrollHeight;
      else container.scrollTop = prevTop;
    }

    // Renders photo/voice note media directly inline in the chat bubble —
    // permanently viewable, same as any normal messaging app.
    function renderMediaBlock(msg) {
      if (msg.mediaType === 'photo') {
        return `
          <img src="${msg.mediaUrl}" onclick="openMediaFullscreen('${msg.mediaUrl}', 'photo')"
               class="rounded-2xl max-w-full max-h-72 object-cover cursor-pointer" alt="Photo">
        `;
      }
      if (msg.mediaType === 'video') {
        return `
          <video src="${msg.mediaUrl}" controls playsinline
                 class="rounded-2xl max-w-full max-h-72" style="min-width:220px;"></video>
        `;
      }
      if (msg.mediaType === 'voice') {
        return `
          <audio src="${msg.mediaUrl}" controls class="max-w-full" style="min-width:220px;"></audio>
        `;
      }
      return '';
    }

    window.openMediaFullscreen = function (url, type) {
      const modal = document.getElementById('view-once-modal');
      const content = document.getElementById('view-once-content');
      if (type === 'photo') {
        content.innerHTML = `<img src="${url}" class="max-w-full max-h-full object-contain">`;
      }
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    };

    // ==========================================================
    // VIEW-ONCE MEDIA (photos + voice notes)
    // Files upload to Firebase Storage, the message stores a storage path
    // + mediaType. Once the recipient opens the viewer, the message flips
    // to `viewed: true` and the underlying file is deleted from Storage —
    // so it genuinely can't be seen a second time, not just hidden in UI.
    // ==========================================================
    let pendingPhotoFile = null;
    let pendingVideoFile = null;
    let mediaRecorder = null;
    let recordedChunks = [];
    let isRecordingVoice = false;
    let pendingVoiceBlob = null;

    const MAX_VIDEO_MB = 50; // keep uploads reasonable over mobile data

    window.handlePhotoSelected = function (event) {
      const file = event.target.files[0];
      if (!file) return;

      if (file.type.startsWith('video/')) {
        if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
          alert(`That video is too large (max ${MAX_VIDEO_MB}MB). Try a shorter clip or lower resolution.`);
          event.target.value = '';
          return;
        }
        pendingVideoFile = file;
        pendingPhotoFile = null;
        pendingVoiceBlob = null;
        const bar = document.getElementById('media-preview-bar');
        const url = URL.createObjectURL(file);
        bar.innerHTML = `
          <div class="flex items-center gap-3 bg-gray-800 rounded-2xl p-2 mb-1">
            <video src="${url}" class="w-12 h-12 object-cover rounded-xl shrink-0" muted></video>
            <p class="text-sm text-gray-300 flex-1 min-w-0 truncate">Video ready to send</p>
            <button onclick="cancelPendingMedia()" class="text-gray-400 hover:text-red-400 px-2"><i class="fas fa-times"></i></button>
          </div>
        `;
        bar.classList.remove('hidden');
        event.target.value = '';
        return;
      }

      if (!file.type.startsWith('image/')) {
        alert('Please choose an image or video file.');
        event.target.value = '';
        return;
      }
      pendingPhotoFile = file;
      pendingVideoFile = null;
      pendingVoiceBlob = null;
      const bar = document.getElementById('media-preview-bar');
      const reader = new FileReader();
      reader.onload = (e) => {
        bar.innerHTML = `
          <div class="flex items-center gap-3 bg-gray-800 rounded-2xl p-2 mb-1">
            <img src="${e.target.result}" class="w-12 h-12 object-cover rounded-xl shrink-0">
            <p class="text-sm text-gray-300 flex-1 min-w-0 truncate">Photo ready to send</p>
            <button onclick="cancelPendingMedia()" class="text-gray-400 hover:text-red-400 px-2"><i class="fas fa-times"></i></button>
          </div>
        `;
        bar.classList.remove('hidden');
      };
      reader.readAsDataURL(file);
      event.target.value = ''; // allow re-selecting the same file later
    };

    window.cancelPendingMedia = function () {
      pendingPhotoFile = null;
      pendingVideoFile = null;
      pendingVoiceBlob = null;
      const bar = document.getElementById('media-preview-bar');
      bar.classList.add('hidden');
      bar.innerHTML = '';
    };

    window.toggleVoiceRecording = async function () {
      if (isRecordingVoice) {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Voice recording isn\'t supported in this browser.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recordedChunks = [];
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
        mediaRecorder.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          isRecordingVoice = false;
          const btn = document.getElementById('voice-record-btn');
          btn.classList.remove('bg-red-600', 'text-white');
          btn.classList.add('bg-gray-800', 'text-gray-300');

          if (recordedChunks.length === 0) return;
          pendingVoiceBlob = new Blob(recordedChunks, { type: 'audio/webm' });
          pendingPhotoFile = null;
          pendingVideoFile = null;
          const bar = document.getElementById('media-preview-bar');
          bar.innerHTML = `
            <div class="flex items-center gap-3 bg-gray-800 rounded-2xl p-3 mb-1">
              <i class="fas fa-microphone text-blue-400"></i>
              <p class="text-sm text-gray-300 flex-1">Voice note ready to send</p>
              <button onclick="cancelPendingMedia()" class="text-gray-400 hover:text-red-400 px-2"><i class="fas fa-times"></i></button>
            </div>
          `;
          bar.classList.remove('hidden');
        };
        mediaRecorder.start();
        isRecordingVoice = true;
        const btn = document.getElementById('voice-record-btn');
        btn.classList.remove('bg-gray-800', 'text-gray-300');
        btn.classList.add('bg-red-600', 'text-white');
      } catch (err) {
        alert('Could not access microphone. Check permissions.');
      }
    };

    // ==========================================================
    // BACKGROUND MEDIA SENDING (WhatsApp / Telegram style)
    // Picking a photo, video or voice note clears the composer right away
    // and drops a "sending" bubble into the chat with a progress ring. The
    // upload runs in the background, so the person can keep typing, open
    // other chats or send more messages. When the upload finishes the
    // bubble is replaced by the real message. If it fails, the bubble shows
    // Retry / Delete instead of losing the file.
    // ==========================================================
    const outbox = [];               // pending media jobs (this session)
    let outboxSeq = 0;
    let currentMessagesChatKey = null; // which chat currentMessagesCache belongs to

    function currentChatKey() {
      if (activeChatType === 'group') return activeGroup ? 'g:' + activeGroup.id : null;
      return activeChatUser ? 'c:' + activeChatUser.uid : null;
    }

    // Everything needed to deliver a message, captured at send time so a
    // background upload still lands in the right chat after the person
    // has switched to another one.
    function buildSendContext() {
      if (activeChatType === 'group') {
        return {
          type: 'group', key: 'g:' + activeGroup.id,
          path: ["groups", activeGroup.id, "messages"],
          groupId: activeGroup.id, members: [...activeGroup.members]
        };
      }
      return {
        type: 'contact', key: 'c:' + activeChatUser.uid,
        path: ["chats", chatIdFor(activeChatUser.uid), "messages"],
        otherUid: activeChatUser.uid
      };
    }

    function buildMessagePayload(ctx, text, replyTo, media) {
      const payload = {
        text,
        senderId: currentUserData.uid,
        createdAt: serverTimestamp(),
        ...(media || {})
      };
      if (ctx.type === 'group') {
        payload.senderName = currentUserData.displayName;
        payload.senderAvatar = currentUserData.avatar || '👤';
      } else {
        payload.recipientId = ctx.otherUid;
      }
      if (replyTo) payload.replyTo = replyTo;
      return payload;
    }

    function previewTextFor(text, mediaType) {
      if (text) return text;
      if (mediaType === 'photo') return '📷 Photo';
      if (mediaType === 'video') return '🎥 Video';
      if (mediaType === 'voice') return '🎤 Voice note';
      return '';
    }

    // Writes the message and updates chat-list previews / unread counts.
    async function postMessage(ctx, payload, previewText) {
      // Not awaited first: offline, the write is saved locally and sent when the network is back,
      // so the chat-list updates below must not wait for the server.
      const sentPromise = addDoc(collection(db, ...ctx.path), payload);
      sentPromise.catch((e) => console.error('Send failed:', e));

      if (ctx.type === 'group') {
        // Bump unread count for every OTHER member (not me), keyed by uid.
        const unreadUpdates = {};
        ctx.members.forEach(uid => {
          if (uid !== currentUserData.uid) unreadUpdates[`unreadCounts.${uid}`] = increment(1);
        });
        await updateDoc(doc(db, "groups", ctx.groupId), {
          lastMessageText: previewText,
          lastMessageAt: serverTimestamp(),
          ...unreadUpdates
        }).catch(() => {});
      } else {
        // Update lastMessageAt on both sides' contact docs so the chat list
        // (sorted by recent activity) reorders for both people, not just me.
        // Only the RECIPIENT's copy gets its unread count bumped.
        const now = serverTimestamp();
        await Promise.all([
          updateDoc(doc(db, "users", currentUserData.uid, "contacts", ctx.otherUid), {
            lastMessageText: previewText, lastMessageAt: now
          }).catch(() => {}),
          updateDoc(doc(db, "users", ctx.otherUid, "contacts", currentUserData.uid), {
            lastMessageText: previewText, lastMessageAt: now, unreadCount: increment(1)
          }).catch(() => {})
        ]);
      }
      await sentPromise.catch(() => {});
    }

    // XMLHttpRequest instead of fetch so we get real upload progress.
    function cloudinaryUpload(job) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        job.xhr = xhr;
        xhr.open('POST', CLOUDINARY_UPLOAD_URL);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setOutboxProgress(job, e.loaded / e.total);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)); } catch (err) { reject(err); }
          } else {
            reject(new Error(`Cloudinary upload failed: ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.onabort = () => { const err = new Error('cancelled'); err.cancelled = true; reject(err); };

        const formData = new FormData();
        formData.append('file', job.file, job.file.name || 'voice-note.webm');
        formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
        formData.append('folder', `chat-media/${job.ctx.path.join('_')}`);
        // Cloudinary's /auto/upload endpoint infers resource_type from the
        // file itself, so video works the same way as photo/voice here.
        xhr.send(formData);
      });
    }

    function queueMediaUpload({ ctx, file, mediaType, text, replyTo }) {
      const job = {
        id: 'ob' + (++outboxSeq),
        ctx, file, mediaType, text, replyTo,
        previewUrl: mediaType === 'voice' ? null : URL.createObjectURL(file),
        progress: 0, status: 'uploading', xhr: null
      };
      outbox.push(job);
      refreshOutboxUI(job);
      runOutboxJob(job);
    }

    async function runOutboxJob(job) {
      job.status = 'uploading';
      job.progress = 0;
      refreshOutboxUI(job);
      try {
        const data = await cloudinaryUpload(job);
        job.progress = 1;
        setOutboxProgress(job, 1);
        const payload = buildMessagePayload(job.ctx, job.text, job.replyTo, {
          mediaType: job.mediaType,
          mediaUrl: data.secure_url,
          mediaPublicId: data.public_id
        });
        await postMessage(job.ctx, payload, previewTextFor(job.text, job.mediaType));
        removeOutboxJob(job);
      } catch (err) {
        if (err && err.cancelled) { removeOutboxJob(job); return; }
        console.error('Media send failed:', err);
        job.status = 'failed';
        job.xhr = null;
        refreshOutboxUI(job);
      }
    }

    function removeOutboxJob(job) {
      const i = outbox.indexOf(job);
      if (i !== -1) outbox.splice(i, 1);
      if (job.previewUrl) { try { URL.revokeObjectURL(job.previewUrl); } catch (_) {} }
      refreshOutboxUI(job);
    }

    window.cancelOutboxJob = function (id) {
      const job = outbox.find(j => j.id === id);
      if (!job) return;
      if (job.status === 'uploading' && job.xhr) job.xhr.abort(); // onabort -> removeOutboxJob
      else removeOutboxJob(job);
    };

    window.retryOutboxJob = function (id) {
      const job = outbox.find(j => j.id === id);
      if (!job || job.status === 'uploading') return;
      runOutboxJob(job);
    };

    function abortAllOutbox() {
      [...outbox].forEach(job => {
        if (job.xhr) { try { job.xhr.abort(); } catch (_) {} }
        removeOutboxJob(job);
      });
    }

    // Warn before closing the tab while something is still uploading.
    window.addEventListener('beforeunload', (e) => {
      if (outbox.some(j => j.status === 'uploading')) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Re-render the chat only if the job belongs to the chat on screen.
    function refreshOutboxUI(job) {
      if (job.ctx.key !== currentChatKey()) return;
      if (currentMessagesChatKey !== job.ctx.key) return; // list not loaded yet; the snapshot will render it
      renderMessages(currentMessagesCache);
    }

    // Progress updates touch only the ring, not the whole message list, so
    // scrolling, video playback and typing are never interrupted.
    const RING_LEN = 2 * Math.PI * 18;
    function setOutboxProgress(job, p) {
      job.progress = p;
      const pct = Math.round(p * 100);
      const ring = document.getElementById(`ob-ring-${job.id}`);
      if (ring) ring.setAttribute('stroke-dashoffset', String(RING_LEN * (1 - p)));
      const label = document.getElementById(`ob-pct-${job.id}`);
      if (label) label.textContent = pct >= 100 ? 'Sending…' : `${pct}%`;
      const bar = document.getElementById(`ob-bar-${job.id}`);
      if (bar) bar.style.width = `${pct}%`;
    }

    function renderOutboxHtml() {
      const key = currentChatKey();
      if (!key) return '';
      const myAvatar = (currentUserData && currentUserData.avatar) || '👤';
      return outbox.filter(j => j.ctx.key === key).map(job => {
        const failed = job.status === 'failed';
        const pct = Math.round(job.progress * 100);
        const dash = RING_LEN * (1 - job.progress);

        const ring = `
          <svg width="44" height="44" viewBox="0 0 44 44" class="-rotate-90">
            <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="3"></circle>
            <circle id="ob-ring-${job.id}" cx="22" cy="22" r="18" fill="none" stroke="#fff" stroke-width="3"
                    stroke-linecap="round" stroke-dasharray="${RING_LEN}" stroke-dashoffset="${dash}"></circle>
          </svg>`;

        let overlay;
        if (failed) {
          overlay = `
            <div class="absolute inset-0 bg-black/60 rounded-2xl flex flex-col items-center justify-center gap-2 p-2">
              <p class="text-xs text-white font-medium">Couldn't send</p>
              <div class="flex gap-2">
                <button onclick="retryOutboxJob('${job.id}')" class="px-3 py-1 bg-white text-gray-900 rounded-full text-xs font-medium"><i class="fas fa-redo"></i> Retry</button>
                <button onclick="cancelOutboxJob('${job.id}')" class="px-3 py-1 bg-white/20 text-white rounded-full text-xs"><i class="fas fa-trash"></i> Delete</button>
              </div>
            </div>`;
        } else {
          overlay = `
            <div class="absolute inset-0 bg-black/40 rounded-2xl flex items-center justify-center">
              <div class="relative w-11 h-11 flex items-center justify-center">
                ${ring}
                <button onclick="cancelOutboxJob('${job.id}')" title="Cancel" class="absolute inset-0 flex items-center justify-center text-white"><i class="fas fa-times text-sm"></i></button>
              </div>
            </div>`;
        }

        let mediaBlock;
        if (job.mediaType === 'photo') {
          mediaBlock = `
            <div class="relative inline-block">
              <img src="${job.previewUrl}" class="rounded-2xl max-w-full max-h-72 object-cover" alt="Sending photo">
              ${overlay}
            </div>`;
        } else if (job.mediaType === 'video') {
          mediaBlock = `
            <div class="relative inline-block">
              <video src="${job.previewUrl}#t=0.1" muted playsinline preload="metadata" class="rounded-2xl max-w-full max-h-72" style="min-width:220px;"></video>
              ${overlay}
            </div>`;
        } else {
          mediaBlock = `
            <div class="flex items-center gap-3" style="min-width:220px;">
              <i class="fas fa-microphone text-lg"></i>
              <div class="flex-1 min-w-0">
                <p class="text-sm">${failed ? "Voice note couldn't send" : 'Sending voice note…'}</p>
                ${failed ? `
                  <div class="flex gap-3 mt-1">
                    <button onclick="retryOutboxJob('${job.id}')" class="text-xs underline"><i class="fas fa-redo"></i> Retry</button>
                    <button onclick="cancelOutboxJob('${job.id}')" class="text-xs underline"><i class="fas fa-trash"></i> Delete</button>
                  </div>` : `
                  <div class="h-1 bg-white/30 rounded-full mt-2 overflow-hidden"><div id="ob-bar-${job.id}" class="h-full bg-white" style="width:${pct}%"></div></div>`}
              </div>
              ${failed ? '' : `<button onclick="cancelOutboxJob('${job.id}')" title="Cancel" class="text-white/80"><i class="fas fa-times"></i></button>`}
            </div>`;
        }

        const caption = job.text ? `<p class="text-[15px] leading-relaxed mt-2">${escapeHtml(job.text)}</p>` : '';
        const status = failed ? 'Failed to send' : `<span id="ob-pct-${job.id}">${pct >= 100 ? 'Sending…' : (pct ? pct + '%' : 'Sending…')}</span>`;
        return `
          <div class="flex flex-col items-start" data-outbox="${job.id}">
            <div class="flex items-end gap-2 justify-start">
              <div class="w-8 h-8 bg-gray-700 rounded-xl flex items-center justify-center text-lg shrink-0">${myAvatar}</div>
              <div class="message-bubble bg-blue-600 text-white rounded-3xl px-5 py-3 ${failed ? 'ring-2 ring-red-400' : ''}">
                ${mediaBlock}
                ${caption}
                <p class="text-[10px] text-right mt-1 opacity-70">${status}</p>
              </div>
            </div>
          </div>`;
      }).join('');
    }

    window.closeViewOnceModal = function () {
      document.getElementById('view-once-modal').classList.add('hidden');
      document.getElementById('view-once-modal').classList.remove('flex');
      document.getElementById('view-once-content').innerHTML = ''; // stop audio/clear image
    };

    window.sendMessage = async function () {
      if (activeChatType === 'group' && !activeGroup) return;
      if (activeChatType === 'contact' && !activeChatUser) return;
      const input = document.getElementById('message-input');
      const text = input.value.trim();
      const hasPendingMedia = !!(pendingPhotoFile || pendingVideoFile || pendingVoiceBlob);
      if (!text && !hasPendingMedia) return;

      const path = activeChatType === 'group'
        ? ["groups", activeGroup.id, "messages"]
        : ["chats", chatIdFor(activeChatUser.uid), "messages"];

      if (editingMessageId) {
        await updateDoc(doc(db, ...path, editingMessageId), {
          text,
          edited: true
        });
        cancelEdit();
        input.value = '';
        return;
      }

      const ctx = buildSendContext();
      const replyTo = replyingToMessage ? {
        messageId: replyingToMessage.id,
        text: replyingToMessage.text,
        senderName: replyingToMessage.senderName
      } : null;

      if (hasPendingMedia) {
        // Hand the file to the background queue and free the composer
        // straight away; the bubble with its progress ring appears in chat.
        const mediaType = pendingPhotoFile ? 'photo' : pendingVideoFile ? 'video' : 'voice';
        const file = pendingPhotoFile || pendingVideoFile || pendingVoiceBlob;
        input.value = '';
        cancelReply();
        cancelPendingMedia();
        queueMediaUpload({ ctx, file, mediaType, text, replyTo });
        return;
      }

      const payload = buildMessagePayload(ctx, text, replyTo);
      input.value = '';
      cancelReply();
      await postMessage(ctx, payload, text);
    };

    // ---------- Reply ----------
    window.startReply = function (messageId) {
      const msg = currentMessagesCache.find(m => m.id === messageId);
      if (!msg) return;
      let senderName = 'Them';
      if (msg.senderId === currentUserData.uid) senderName = 'You';
      else if (activeChatType === 'group') senderName = msg.senderName || 'Member';
      else senderName = activeChatUser?.displayName || 'Them';
      replyingToMessage = { id: msg.id, text: msg.text, senderName };
      cancelEdit(); // can't reply and edit at once
      renderComposerBanner();
      document.getElementById('message-input').focus();
    };

    window.cancelReply = function () {
      replyingToMessage = null;
      renderComposerBanner();
    };

    // ---------- Edit ----------
    window.startEdit = function (messageId) {
      const msg = currentMessagesCache.find(m => m.id === messageId);
      if (!msg || msg.senderId !== currentUserData.uid) return;
      editingMessageId = msg.id;
      cancelReply(); // can't reply and edit at once
      document.getElementById('message-input').value = msg.text;
      renderComposerBanner();
      document.getElementById('message-input').focus();
    };

    window.cancelEdit = function () {
      if (editingMessageId) {
        document.getElementById('message-input').value = '';
      }
      editingMessageId = null;
      renderComposerBanner();
    };

    // ---------- Delete ----------
    window.deleteMessage = async function (messageId) {
      const msg = currentMessagesCache.find(m => m.id === messageId);
      if (!msg || msg.senderId !== currentUserData.uid) return; // only your own messages
      if (activeChatType === 'group' && !activeGroup) return;
      if (activeChatType === 'contact' && !activeChatUser) return;
      if (!confirm('Delete this message? This cannot be undone.')) return;
      const path = activeChatType === 'group'
        ? ["groups", activeGroup.id, "messages"]
        : ["chats", chatIdFor(activeChatUser.uid), "messages"];
      await deleteDoc(doc(db, ...path, messageId));
      if (editingMessageId === messageId) cancelEdit();
    };

    function renderComposerBanner() {
      const banner = document.getElementById('composer-banner');
      if (editingMessageId) {
        banner.innerHTML = `
          <div class="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700">
            <div class="flex items-center gap-2 text-sm text-blue-400 min-w-0">
              <i class="fas fa-pen"></i> <span class="truncate">Editing message</span>
            </div>
            <button onclick="cancelEdit()" class="text-gray-400 hover:text-white px-2"><i class="fas fa-times"></i></button>
          </div>
        `;
        banner.classList.remove('hidden');
      } else if (replyingToMessage) {
        banner.innerHTML = `
          <div class="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700">
            <div class="min-w-0">
              <p class="text-xs text-blue-400 font-medium">Replying to ${escapeHtml(replyingToMessage.senderName)}</p>
              <p class="text-xs text-gray-400 truncate">${escapeHtml(replyingToMessage.text)}</p>
            </div>
            <button onclick="cancelReply()" class="text-gray-400 hover:text-white px-2 shrink-0"><i class="fas fa-times"></i></button>
          </div>
        `;
        banner.classList.remove('hidden');
      } else {
        banner.classList.add('hidden');
        banner.innerHTML = '';
      }
    }

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str ?? '';
      return div.innerHTML;
    }

    document.addEventListener('click', (e) => {
      if (window.innerWidth < 768) {
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.contains(e.target) && !e.target.closest('button')) {
          sidebar.classList.remove('open');
          isSidebarOpen = false;
        }
      }
    });

    window.addEventListener('resize', () => {
      if (!document.getElementById('main-app').classList.contains('hidden')) {
        const m = document.getElementById('messages');
        if (m.scrollHeight - m.scrollTop - m.clientHeight < 250) m.scrollTop = m.scrollHeight;
      }
    });

    // ---------- Settings modal ----------
    let selectedAvatar = null;

    window.openSettings = function () { switchTab(7); };

    function fillSettingsForm() {
      const picker = document.getElementById('avatar-picker');
      selectedAvatar = currentUserData.avatar || '👤';

      picker.innerHTML = AVATARS.map(a => `
        <button onclick="selectAvatar('${a}')" data-avatar="${a}"
          class="avatar-option w-9 h-9 rounded-xl flex items-center justify-center text-xl ${a === selectedAvatar ? 'bg-blue-600' : 'bg-gray-800'}">
          ${a}
        </button>
      `).join('');

      document.getElementById('settings-display-name').value = currentUserData.displayName || '';
      document.getElementById('settings-region').value = currentUserData.region || '';
      document.getElementById('settings-profession').value = currentUserData.profession || '';
      document.getElementById('settings-error').classList.add('hidden');
      document.getElementById('settings-success').classList.add('hidden');

      syncReadReceiptsToggle();
      syncThemeButtons();
      syncAppLockSettingsUI();
      syncPushNotificationUI();
    }

    window.closeSettings = function () {
      switchTab(0);
      // Settings can be opened from the landing view or while a chat is open.
      // If the user is inside a chat, the Settings close button returns them
      // to the full landing page instead of leaving them on a broken route.
      if (IS_CHAT_PAGE) goToChatList();
    };

    // ==========================================================
    // FEED (paid). Posts live in posts/{id}. Access = a document at
    // subscriptions/{uid} with an "until" date in the future. The rules
    // enforce it, so hiding the UI is not the only protection. Admins can
    // grant/remove access from the Admin tab; a payment webhook can write the
    // same document later (see CHANGES.md).
    // ==========================================================
    // ---- Payment (Paystack) ----
    // PAYSTACK_PUBLIC_KEY: Paystack dashboard -> Settings -> API Keys -> Public key (starts pk_live_ or pk_test_).
    // It is safe to put here (it cannot take money out). NEVER put the secret key (sk_...) in this file.
    const PAYSTACK_PUBLIC_KEY = "pk_live_2ba5cbefa3342a85256b0492a64f4d5ad554bbce";
    const FEED_PRICE_NGN = 500;
    const FEED_DAYS = 30;
    const FEED_PAYMENT_URL = ""; // optional fallback: a Paystack payment-page link, used if no public key is set
    let feedAccess = false, unsubFeed = null, feedPosts = [], feedFile = null, feedPosting = false;

    function stopFeed() {
      if (unsubFeed) { unsubFeed(); unsubFeed = null; }
      feedPosts = []; feedAccess = false;
    }

    async function checkFeedAccess() {
      if (isAdminUser) return true;
      try {
        const snap = await getDoc(doc(db, "subscriptions", currentUserData.uid));
        if (!snap.exists()) return false;
        const until = snap.data().until;
        const ms = until && until.toMillis ? until.toMillis() : 0;
        return ms > Date.now();
      } catch (_) { return false; }
    }

    async function openFeedTab() {
      feedAccess = await checkFeedAccess();
      feedRand = new Map(); // fresh mix each time you open Feed
      document.getElementById('feed-paywall').classList.toggle('hidden', feedAccess);
      document.getElementById('feed-new-btn').classList.toggle('hidden', !feedAccess);
      document.getElementById('feed-list').classList.toggle('hidden', !feedAccess);
      if (!feedAccess) { stopFeed(); return; }
      if (unsubFeed) return;
      const q = query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(100));
      unsubFeed = onSnapshot(q, (snap) => {
        feedPosts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderFeed();
      }, (err) => {
        console.error('Feed listener error:', err);
        feedAccess = false; stopFeed();
        document.getElementById('feed-paywall').classList.remove('hidden');
      });
    }

    window.refreshFeedAccess = async function () {
      const note = document.getElementById('feed-paywall-note');
      note.classList.remove('hidden');
      note.textContent = 'Checking…';
      feedAccess = await checkFeedAccess();
      if (!feedAccess) {
        // Not active yet: re-check any payment this user has already made (e.g. the first check failed).
        try {
          const mine = await getDocs(query(collection(db, "paymentClaims"), where("uid", "==", currentUserData.uid)));
          for (const d of mine.docs) {
            if (d.data().status === 'pending' || d.data().status === 'approved') {
              if (await verifyFeedPaymentOnServer(d.id)) { feedAccess = await checkFeedAccess(); if (feedAccess) break; }
            }
          }
        } catch (e) { console.error('Re-check failed:', e); }
      }
      if (feedAccess) { note.classList.add('hidden'); openFeedTab(); }
      else {
        note.textContent = "No active subscription found yet. If you just paid, wait a minute and tap again. Still nothing? Contact support with your payment reference.";
      }
    };

    // Ask our server (api/verify-payment.js) to confirm the payment with Paystack and switch Feed on.
    async function verifyFeedPaymentOnServer(reference) {
      try {
        const token = await auth.currentUser.getIdToken();
        const res = await fetch('/api/verify-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ reference })
        });
        const data = await res.json().catch(() => ({}));
        return !!(res.ok && data.ok);
      } catch (e) { console.error('verify-payment call failed:', e); return false; }
    }

    async function activateFeedPayment(reference) {
      const note = document.getElementById('feed-paywall-note');
      note.classList.remove('hidden');
      note.textContent = 'Payment received. Activating Feed…';
      if (await verifyFeedPaymentOnServer(reference)) {
        note.classList.add('hidden');
        feedAccess = false; stopFeed();
        openFeedTab();
        return;
      }
      // Server could not confirm right now: save the claim so it can be re-checked / approved by an admin.
      recordFeedPayment(reference);
    }

    function loadPaystack() {
      return new Promise((resolve, reject) => {
        if (window.PaystackPop) return resolve();
        const s = document.createElement('script');
        s.src = 'https://js.paystack.co/v1/inline.js';
        s.onload = resolve; s.onerror = () => reject(new Error('Could not load Paystack'));
        document.head.appendChild(s);
      });
    }

    // After a successful Paystack payment the app records a claim with the payment reference.
    // An admin confirms it against the Paystack dashboard and approves (grants FEED_DAYS days).
    // Fully automatic activation needs a server webhook: see later-payment-webhook/.
    window.startFeedSubscription = async function () {
      const note = document.getElementById('feed-paywall-note');
      note.classList.remove('hidden');
      if (!PAYSTACK_PUBLIC_KEY) {
        if (FEED_PAYMENT_URL) { window.open(FEED_PAYMENT_URL, '_blank', 'noopener'); return; }
        note.textContent = "Payments are not switched on yet. Please check back soon.";
        return;
      }
      note.textContent = 'Opening payment…';
      try {
        await loadPaystack();
        const ref = 'pc_' + currentUserData.uid.slice(0, 8) + '_' + Date.now();
        const handler = window.PaystackPop.setup({
          key: PAYSTACK_PUBLIC_KEY,
          email: auth.currentUser.email || (currentUserData.email || 'user@privatechat.app'),
          amount: FEED_PRICE_NGN * 100, // kobo
          currency: 'NGN',
          ref,
          metadata: { uid: currentUserData.uid, product: 'feed-30d' },
          callback: function (response) {
            // Paystack's callback must be a plain function (not async).
            activateFeedPayment(response.reference || ref);
          },
          onClose: function () {
            if (note.textContent === 'Opening payment…') note.classList.add('hidden');
          }
        });
        handler.openIframe();
      } catch (e) {
        console.error('Paystack error:', e);
        note.textContent = 'Could not open payment. Check your connection and try again.';
      }
    };

    async function recordFeedPayment(reference) {
      const note = document.getElementById('feed-paywall-note');
      try {
        await setDoc(doc(db, "paymentClaims", reference), {
          uid: currentUserData.uid,
          displayName: currentUserData.displayName || '',
          reference,
          amount: FEED_PRICE_NGN,
          status: 'pending',
          createdAt: serverTimestamp()
        });
        note.textContent = "Payment received ✅ We're confirming it. Tap \"I've paid, refresh\" in a minute.";
      } catch (e) {
        console.error('Recording payment failed:', e);
        note.textContent = 'Paid, but we could not record it. Send support this reference: ' + reference;
      }
      note.classList.remove('hidden');
    }

    window.openFeedComposer = function () {
      document.getElementById('feed-composer').classList.remove('hidden');
      document.getElementById('feed-error').classList.add('hidden');
    };
    window.closeFeedComposer = function () {
      document.getElementById('feed-composer').classList.add('hidden');
      document.getElementById('feed-text').value = '';
      document.getElementById('feed-file').value = '';
      document.getElementById('feed-file-name').classList.add('hidden');
      feedFile = null;
    };
    window.onFeedFilePicked = function (input) {
      const f = input.files && input.files[0];
      const label = document.getElementById('feed-file-name');
      if (!f) { feedFile = null; label.classList.add('hidden'); return; }
      const maxMb = f.type.startsWith('video') ? 40 : 10;
      if (f.size > maxMb * 1024 * 1024) { alert(`That ${f.type.startsWith('video') ? 'video' : 'photo'} is over ${maxMb} MB. Trim or compress it first.`); input.value = ''; return; }
      feedFile = f;
      label.textContent = '📎 ' + f.name;
      label.classList.remove('hidden');
    };

    // XHR (not fetch) so a big video shows real progress and doesn't have to be held in memory by us.
    function feedUpload(file, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', CLOUDINARY_UPLOAD_URL);
        xhr.timeout = 10 * 60 * 1000;
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(e); }
          } else reject(new Error('Upload failed: ' + xhr.status + ' ' + xhr.responseText.slice(0, 200)));
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.ontimeout = () => reject(new Error('Upload timed out'));
        const fd = new FormData();
        fd.append('file', file);
        fd.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
        fd.append('folder', 'feed');
        xhr.send(fd);
      });
    }

    window.submitFeedPost = async function () {
      if (feedPosting) return;
      const err = document.getElementById('feed-error');
      const text = document.getElementById('feed-text').value.trim();
      if (!text && !feedFile) { err.textContent = 'Write something or add a photo/video.'; err.classList.remove('hidden'); return; }
      const btn = document.getElementById('feed-post-btn');
      feedPosting = true; btn.disabled = true; btn.textContent = 'Posting…'; err.classList.add('hidden');
      try {
        const post = {
          uid: currentUserData.uid,
          displayName: currentUserData.displayName || 'User',
          avatar: currentUserData.avatar || '👤',
          text,
          likedBy: [],
          createdAt: serverTimestamp()
        };
        if (feedFile) {
          const data = await feedUpload(feedFile, (pct) => { btn.textContent = 'Uploading ' + pct + '%'; });
          post.mediaUrl = data.secure_url;
          post.mediaType = feedFile.type.startsWith('video') ? 'video' : 'photo';
          btn.textContent = 'Posting…';
        }
        await addDoc(collection(db, "posts"), post);
        closeFeedComposer();
      } catch (e) {
        console.error('Post failed:', e);
        err.textContent = 'Could not post. Check your connection and that your Feed subscription is active.';
        err.classList.remove('hidden');
      } finally {
        feedPosting = false; btn.disabled = false; btn.textContent = 'Post';
      }
    };

    function feedTimeAgo(ts) {
      const ms = ts && ts.toMillis ? ts.toMillis() : Date.now();
      const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + 'm';
      if (s < 86400) return Math.floor(s / 3600) + 'h';
      return Math.floor(s / 86400) + 'd';
    }

    // The feed is a mix, not a timeline: every post gets a random score (kept for the session so the
    // list doesn't jump around when someone likes a post), nudged up a little if it is recent.
    let feedRand = new Map();
    function feedScore(p) {
      if (!feedRand.has(p.id)) feedRand.set(p.id, Math.random());
      const ageDays = Math.max(0, (Date.now() - (p.createdAt && p.createdAt.toMillis ? p.createdAt.toMillis() : Date.now())) / 86400000);
      const fresh = 1 - Math.min(ageDays / 7, 1);
      return feedRand.get(p.id) * 0.75 + fresh * 0.25;
    }
    window.shuffleFeed = function () {
      feedRand = new Map();
      renderFeed();
      document.getElementById('feed-tab').scrollTo({ top: 0, behavior: 'smooth' });
    };

    function renderFeed() {
      const list = document.getElementById('feed-list');
      feedPosts = feedPosts.slice().sort((a, b) => feedScore(b) - feedScore(a));
      document.getElementById('feed-empty').classList.toggle('hidden', feedPosts.length > 0);
      const me = currentUserData.uid;
      list.innerHTML = feedPosts.map(p => {
        const liked = (p.likedBy || []).includes(me);
        const count = (p.likedBy || []).length;
        const safeMedia = typeof p.mediaUrl === 'string' && p.mediaUrl.startsWith('https://res.cloudinary.com/');
        const media = !safeMedia ? '' : p.mediaType === 'video'
          ? (() => {
              // Cloudinary converts iPhone .mov (HEVC) to H.264 mp4 on delivery so it plays everywhere.
              const src = p.mediaUrl.replace('/video/upload/', '/video/upload/f_mp4,vc_h264,q_auto/');
              const poster = p.mediaUrl.replace('/video/upload/', '/video/upload/so_0,f_jpg,w_800/').replace(/\.[a-z0-9]+$/i, '.jpg');
              return `<video src="${src}" poster="${poster}" controls playsinline preload="none" class="w-full max-h-[70vh] rounded-xl bg-black mt-2"></video>`;
            })()
          : `<img src="${p.mediaUrl}" loading="lazy" alt="" class="w-full max-h-[70vh] object-contain rounded-xl bg-black mt-2">`;
        const mine = p.uid === me;
        const msgBtn = mine ? '' : `<button onclick="messagePostAuthor('${p.id}')" class="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1"><i class="fas fa-comment"></i> Message</button>`;
        const delBtn = (mine || isAdminUser) ? `<button onclick="deleteFeedPost('${p.id}')" class="text-gray-500 hover:text-red-400 text-sm ml-auto"><i class="fas fa-trash"></i></button>` : '';
        return `
          <div class="p-3 bg-gray-800/50 rounded-2xl" data-post="${p.id}">
            <div class="flex items-center gap-2">
              <div class="w-9 h-9 bg-gray-700 rounded-xl flex items-center justify-center text-xl shrink-0">${escapeHtml(p.avatar || '👤')}</div>
              <div class="min-w-0"><p class="font-medium text-sm truncate">${escapeHtml(p.displayName || 'User')}</p>
              <p class="text-[11px] text-gray-500">${feedTimeAgo(p.createdAt)}</p></div>
            </div>
            ${p.text ? `<p class="text-sm mt-2 whitespace-pre-wrap break-words">${escapeHtml(p.text)}</p>` : ''}
            ${media}
            <div class="flex items-center gap-4 mt-3">
              <button onclick="toggleFeedLike('${p.id}')" class="text-sm flex items-center gap-1 ${liked ? 'text-red-400' : 'text-gray-400 hover:text-red-400'}">
                <i class="${liked ? 'fas' : 'far'} fa-heart"></i> ${count}
              </button>
              ${msgBtn}${delBtn}
            </div>
            <div id="feed-msg-box-${p.id}"></div>
          </div>`;
      }).join('');
    }

    window.toggleFeedLike = async function (postId) {
      const p = feedPosts.find(x => x.id === postId);
      if (!p) return;
      const me = currentUserData.uid;
      const liked = (p.likedBy || []).includes(me);
      try {
        await updateDoc(doc(db, "posts", postId), { likedBy: liked ? arrayRemove(me) : arrayUnion(me) });
      } catch (e) { console.error('Like failed:', e); }
    };

    window.deleteFeedPost = async function (postId) {
      if (!confirm('Delete this post?')) return;
      try { await deleteDoc(doc(db, "posts", postId)); } catch (e) { console.error('Delete failed:', e); }
    };

    // "Message" on a post: open the chat if they are already a contact,
    // otherwise show the same one-message request box used in Discover.
    window.messagePostAuthor = function (postId) {
      const p = feedPosts.find(x => x.id === postId);
      if (!p) return;
      if (contacts.some(c => c.uid === p.uid)) { openChatWith(p.uid); return; }
      const box = document.getElementById(`feed-msg-box-${postId}`);
      if (!box) return;
      box.innerHTML = `
        <textarea id="feed-req-${postId}" rows="2" placeholder="Say hello (your one message until they accept)"
          class="w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 mt-3 mb-2"></textarea>
        <button onclick="sendFeedRequest('${postId}')" class="w-full py-2.5 bg-blue-600 hover:bg-blue-700 rounded-xl text-sm font-medium">Send Request</button>`;
    };
    window.sendFeedRequest = async function (postId) {
      const p = feedPosts.find(x => x.id === postId);
      if (!p) return;
      try {
        await sendContactRequest(p.uid, `feed-req-${postId}`);
        const box = document.getElementById(`feed-msg-box-${postId}`);
        if (box) box.innerHTML = `<p class="text-green-400 text-xs mt-3">Request sent ✅ You can chat once they accept.</p>`;
      } catch (e) { console.error('Request failed:', e); }
    };

    let unsubClaims = null;
    function listenToPaymentClaims() {
      if (unsubClaims) return;
      const q = query(collection(db, "paymentClaims"), where("status", "==", "pending"));
      unsubClaims = onSnapshot(q, (snap) => {
        const box = document.getElementById('admin-payments');
        const list = document.getElementById('admin-payments-list');
        box.classList.toggle('hidden', snap.empty);
        list.innerHTML = snap.docs.map(d => {
          const c = d.data();
          return `<div class="flex items-center gap-2 p-2 bg-gray-800/60 rounded-xl">
            <div class="flex-1 min-w-0"><p class="text-sm font-medium truncate">${escapeHtml(c.displayName || c.uid)}</p>
            <p class="text-[11px] text-gray-400 break-all">${escapeHtml(c.reference)}</p></div>
            <button onclick="adminApprovePayment('${escapeHtml(d.id)}')" class="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-xs font-semibold">Approve</button>
            <button onclick="adminRejectPayment('${escapeHtml(d.id)}')" class="px-2 py-1.5 text-red-400 text-xs">Reject</button>
          </div>`;
        }).join('');
      }, (err) => console.error('Payment claims listener:', err));
    }
    window.adminApprovePayment = async function (id) {
      if (!isAdminUser) return;
      try {
        const ref = doc(db, "paymentClaims", id);
        const snap = await getDoc(ref);
        if (!snap.exists()) return;
        const uid = snap.data().uid;
        const cur = await getDoc(doc(db, "subscriptions", uid));
        const curMs = cur.exists() && cur.data().until && cur.data().until.toMillis ? cur.data().until.toMillis() : 0;
        const startMs = Math.max(Date.now(), curMs); // paying early adds on to the time left
        await setDoc(doc(db, "subscriptions", uid), {
          until: new Date(startMs + FEED_DAYS * 86400000), grantedBy: currentUserData.uid,
          grantedAt: serverTimestamp(), paymentRef: id
        });
        await updateDoc(ref, { status: 'approved', approvedBy: currentUserData.uid });
      } catch (e) { console.error(e); alert('Failed: ' + (e.message || e)); }
    };
    window.adminRejectPayment = async function (id) {
      if (!isAdminUser || !confirm('Reject this payment claim?')) return;
      try { await updateDoc(doc(db, "paymentClaims", id), { status: 'rejected' }); } catch (e) { console.error(e); }
    };

    window.adminGrantFeed = async function (uid, days) {
      if (!isAdminUser) return;
      try {
        if (days > 0) {
          await setDoc(doc(db, "subscriptions", uid), {
            until: new Date(Date.now() + days * 86400000), grantedBy: currentUserData.uid, grantedAt: serverTimestamp()
          });
          alert(`Feed access granted for ${days} days.`);
        } else {
          await deleteDoc(doc(db, "subscriptions", uid));
          alert('Feed access removed.');
        }
      } catch (e) { console.error(e); alert('Failed: ' + (e.message || e)); }
    };

    // ---------- Privacy Policy ----------
    window.openPrivacyPolicy = function () {
      document.getElementById('privacy-policy-modal').classList.remove('hidden');
    };
    window.closePrivacyPolicy = function () {
      document.getElementById('privacy-policy-modal').classList.add('hidden');
    };

    // ---------- Feedback ----------
    window.openFeedback = function () {
      document.getElementById('feedback-text').value = '';
      document.getElementById('feedback-type').value = 'bug';
      document.getElementById('feedback-error').classList.add('hidden');
      document.getElementById('feedback-success').classList.add('hidden');
      document.getElementById('feedback-modal').classList.remove('hidden');
    };
    window.closeFeedback = function () {
      document.getElementById('feedback-modal').classList.add('hidden');
    };
    window.submitFeedback = async function () {
      const errEl = document.getElementById('feedback-error');
      const okEl = document.getElementById('feedback-success');
      errEl.classList.add('hidden');
      okEl.classList.add('hidden');

      const type = document.getElementById('feedback-type').value;
      const text = document.getElementById('feedback-text').value.trim();
      if (!text) {
        errEl.textContent = 'Please write your feedback before sending.';
        errEl.classList.remove('hidden');
        return;
      }

      try {
        await addDoc(collection(db, "feedback"), {
          type,
          text,
          senderId: currentUserData.uid,
          senderName: currentUserData.displayName,
          senderEmail: currentUserData.email || '',
          createdAt: serverTimestamp()
        });
        okEl.textContent = 'Thanks! Your feedback has been sent.';
        okEl.classList.remove('hidden');
        document.getElementById('feedback-text').value = '';
        setTimeout(() => closeFeedback(), 1500);
      } catch (err) {
        errEl.textContent = 'Could not send feedback — try again.';
        errEl.classList.remove('hidden');
        console.error(err);
      }
    };

    // ---------- Reminders (personal, private to each user) ----------
    let reminders = [];
    let unsubReminders = null;
    let editingReminderId = null;

    function listenToReminders() {
      if (!currentUserData) return;
      const q = query(collection(db, "users", currentUserData.uid, "reminders"), orderBy("dueAt", "asc"));
      unsubReminders = onSnapshot(q, (snap) => {
        reminders = [];
        snap.forEach(d => reminders.push({ id: d.id, ...d.data() }));
        renderRemindersList();
      });
    }

    window.openReminders = function () {
      document.getElementById('reminders-modal').classList.remove('hidden');
      hideAddReminderForm();
      renderRemindersList();
    };

    window.closeReminders = function () {
      document.getElementById('reminders-modal').classList.add('hidden');
    };

    window.showAddReminderForm = function () {
      editingReminderId = null;
      document.getElementById('reminder-title-input').value = '';
      document.getElementById('reminder-notes-input').value = '';
      document.getElementById('reminder-datetime-input').value = '';
      document.getElementById('reminder-form-error').classList.add('hidden');
      document.getElementById('reminder-form').classList.remove('hidden');
      document.getElementById('add-reminder-btn').classList.add('hidden');
    };

    window.hideAddReminderForm = function () {
      editingReminderId = null;
      document.getElementById('reminder-form').classList.add('hidden');
      document.getElementById('add-reminder-btn').classList.remove('hidden');
    };

    window.editReminder = function (reminderId) {
      const r = reminders.find(x => x.id === reminderId);
      if (!r) return;
      editingReminderId = reminderId;
      document.getElementById('reminder-title-input').value = r.title || '';
      document.getElementById('reminder-notes-input').value = r.notes || '';
      if (r.dueAt && r.dueAt.toDate) {
        const d = r.dueAt.toDate();
        // datetime-local needs "YYYY-MM-DDTHH:MM" in LOCAL time, not UTC.
        const pad = n => String(n).padStart(2, '0');
        const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        document.getElementById('reminder-datetime-input').value = local;
      }
      document.getElementById('reminder-form-error').classList.add('hidden');
      document.getElementById('reminder-form').classList.remove('hidden');
      document.getElementById('add-reminder-btn').classList.add('hidden');
    };

    window.saveReminder = async function () {
      const errEl = document.getElementById('reminder-form-error');
      errEl.classList.add('hidden');

      const title = document.getElementById('reminder-title-input').value.trim();
      const notes = document.getElementById('reminder-notes-input').value.trim();
      const datetimeVal = document.getElementById('reminder-datetime-input').value;

      if (!title) {
        errEl.textContent = 'Give your reminder a title.';
        errEl.classList.remove('hidden');
        return;
      }

      let dueDate = null;
      if (datetimeVal) {
        dueDate = new Date(datetimeVal); // interpreted in the browser's local timezone
        if (isNaN(dueDate.getTime())) {
          errEl.textContent = 'That date/time looks invalid.';
          errEl.classList.remove('hidden');
          return;
        }
      }

      try {
        if (editingReminderId) {
          await updateDoc(doc(db, "users", currentUserData.uid, "reminders", editingReminderId), {
            title, notes, dueAt: dueDate
          });
        } else {
          await addDoc(collection(db, "users", currentUserData.uid, "reminders"), {
            title, notes, dueAt: dueDate, completed: false, createdAt: serverTimestamp()
          });
        }
        hideAddReminderForm();
      } catch (err) {
        errEl.textContent = 'Could not save — try again.';
        errEl.classList.remove('hidden');
        console.error(err);
      }
    };

    window.toggleReminderComplete = async function (reminderId, completed) {
      await updateDoc(doc(db, "users", currentUserData.uid, "reminders", reminderId), { completed }).catch(() => {});
    };

    window.deleteReminder = async function (reminderId) {
      if (!confirm('Delete this reminder?')) return;
      await deleteDoc(doc(db, "users", currentUserData.uid, "reminders", reminderId)).catch(() => {});
    };

    function renderRemindersList() {
      const container = document.getElementById('reminders-list');
      if (!container) return;
      if (reminders.length === 0) {
        container.innerHTML = `<p class="text-gray-500 text-sm text-center py-8">No reminders yet. Tap "New Reminder" to add one.</p>`;
        return;
      }

      const now = Date.now();
      const sorted = [...reminders].sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1; // incomplete first
        return toMillis(a.dueAt) - toMillis(b.dueAt);
      });

      container.innerHTML = sorted.map(r => {
        const dueMs = toMillis(r.dueAt);
        const dueDate = r.dueAt && r.dueAt.toDate ? r.dueAt.toDate() : null;
        const isOverdue = !r.completed && dueMs && dueMs < now;
        const dueLabel = dueDate
          ? dueDate.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '';
        return `
          <div class="p-3 bg-gray-800 rounded-2xl ${r.completed ? 'opacity-50' : ''}">
            <div class="flex items-start gap-3">
              <button onclick="toggleReminderComplete('${r.id}', ${!r.completed})" class="mt-0.5 w-5 h-5 rounded-full border-2 ${r.completed ? 'bg-blue-600 border-blue-600' : 'border-gray-500'} flex items-center justify-center shrink-0">
                ${r.completed ? '<i class="fas fa-check text-[10px] text-white"></i>' : ''}
              </button>
              <div class="flex-1 min-w-0">
                <p class="font-medium ${r.completed ? 'line-through' : ''} truncate">${escapeHtml(r.title)}</p>
                ${r.notes ? `<p class="text-xs text-gray-400 mt-0.5">${escapeHtml(r.notes)}</p>` : ''}
                <p class="text-xs mt-1 ${isOverdue ? 'text-red-400' : 'text-gray-500'}">${isOverdue ? 'Overdue · ' : ''}${dueLabel}</p>
              </div>
              <div class="flex gap-2 shrink-0">
                <button onclick="editReminder('${r.id}')" class="text-gray-500 hover:text-gray-300 text-xs"><i class="fas fa-pen"></i></button>
                <button onclick="deleteReminder('${r.id}')" class="text-gray-500 hover:text-red-400 text-xs"><i class="fas fa-trash"></i></button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    // ---------- Read receipts toggle ----------
    function syncReadReceiptsToggle() {
      const enabled = currentUserData.readReceiptsEnabled !== false; // default on
      const toggle = document.getElementById('read-receipts-toggle');
      const knob = document.getElementById('read-receipts-knob');
      toggle.classList.toggle('bg-blue-600', enabled);
      toggle.classList.toggle('bg-gray-700', !enabled);
      knob.style.transform = enabled ? 'translateX(20px)' : 'translateX(0)';
    }

    window.toggleReadReceipts = async function () {
      const newValue = currentUserData.readReceiptsEnabled === false; // flip
      currentUserData.readReceiptsEnabled = newValue;
      syncReadReceiptsToggle();
      await updateDoc(doc(db, "users", currentUserData.uid), { readReceiptsEnabled: newValue }).catch(() => {});
    };

    // ---------- Theme selection in Settings ----------
    window.setTheme = function (pref) {
      localStorage.setItem('privatechat-theme', pref);
      applyTheme(pref);
      syncThemeButtons();
    };

    function syncThemeButtons() {
      const current = localStorage.getItem('privatechat-theme') || 'auto';
      ['auto', 'light', 'dark'].forEach(t => {
        const btn = document.getElementById(`theme-btn-${t}`);
        if (btn) btn.classList.toggle('theme-btn-active', t === current);
      });
    }

    window.selectAvatar = function (avatar) {
      selectedAvatar = avatar;
      document.querySelectorAll('.avatar-option').forEach(btn => {
        btn.classList.toggle('bg-blue-600', btn.dataset.avatar === avatar);
        btn.classList.toggle('bg-gray-800', btn.dataset.avatar !== avatar);
      });
    };

    window.saveSettings = async function () {
      const errEl = document.getElementById('settings-error');
      const okEl = document.getElementById('settings-success');
      errEl.classList.add('hidden');
      okEl.classList.add('hidden');

      const newName = document.getElementById('settings-display-name').value.trim();
      const newRegion = document.getElementById('settings-region').value.trim();
      const newProfession = document.getElementById('settings-profession').value.trim();

      if (!newName) {
        errEl.textContent = 'Display name cannot be empty.';
        errEl.classList.remove('hidden');
        return;
      }

      const nameOrAvatarChanged = newName !== currentUserData.displayName || (selectedAvatar && selectedAvatar !== currentUserData.avatar);

      try {
        await updateDoc(doc(db, "users", currentUserData.uid), {
          displayName: newName,
          avatar: selectedAvatar || currentUserData.avatar,
          region: newRegion,
          profession: newProfession
        });

        currentUserData.profession = newProfession;

        // Keep local state and header UI in sync immediately
        currentUserData.displayName = newName;
        currentUserData.avatar = selectedAvatar || currentUserData.avatar;
        currentUserData.region = newRegion;
        document.getElementById('current-user').textContent = newName;
        updateMyAvatarDisplay();

        if (nameOrAvatarChanged) {
          okEl.textContent = 'Saved ✅ Updating your info for contacts and groups...';
          okEl.classList.remove('hidden');
          await propagateProfileUpdate();
        }

        okEl.textContent = 'Saved ✅';
        okEl.classList.remove('hidden');
      } catch (err) {
        errEl.textContent = 'Something went wrong saving your changes.';
        errEl.classList.remove('hidden');
      }
    };

    // When a person changes their name/avatar, everyone who already has them
    // as a contact (or in a group with them) is holding a stale copy —
    // contact/group member snapshots are written once, not live references.
    // Push the update out to every place that stored a copy.
    async function propagateProfileUpdate() {
      const myUid = currentUserData.uid;
      const newInfo = { displayName: currentUserData.displayName, avatar: currentUserData.avatar };

      // 1) Update my entry inside every contact's contacts subcollection.
      try {
        const q = query(collectionGroup(db, "contacts"), where("uid", "==", myUid));
        const snap = await getDocs(q);
        const updates = snap.docs.map(d => updateDoc(d.ref, {
          displayName: newInfo.displayName,
          avatar: newInfo.avatar
        }).catch(() => {}));
        await Promise.all(updates);
      } catch (err) {
        console.warn('Contact propagation skipped:', err);
      }

      // 2) Update my entry inside memberInfo for every group I belong to.
      try {
        const gq = query(collection(db, "groups"), where("members", "array-contains", myUid));
        const gsnap = await getDocs(gq);
        const gUpdates = gsnap.docs.map(d => {
          const data = d.data();
          const updatedMemberInfo = { ...(data.memberInfo || {}), [myUid]: newInfo };
          return updateDoc(d.ref, { memberInfo: updatedMemberInfo }).catch(() => {});
        });
        await Promise.all(gUpdates);
      } catch (err) {
        console.warn('Group propagation skipped:', err);
      }
    }

    function updateMyAvatarDisplay() {
      const emojiEl = document.getElementById('my-avatar-emoji');
      if (emojiEl) emojiEl.textContent = currentUserData.avatar || '👤';
    }

    // ==========================================================
    // STATUS / STORIES
    // Data model: statuses/{statusId} — uid, displayName, avatar,
    // mediaUrl, caption, createdAt, expiresAt (24h), hiddenFrom: [uid,...].
    // Reuses the same Cloudinary upload path as chat photos. Firestore has
    // no built-in TTL for client SDKs, so expiry is enforced by filtering
    // out anything past expiresAt at read time — expired docs just sit
    // unused in Firestore until naturally ignored (fine at this scale).
    // ==========================================================

    function listenToMyStatuses() {
      const q = query(collection(db, "statuses"), where("uid", "==", currentUserData.uid));
      if (unsubMyStatuses) unsubMyStatuses();
      unsubMyStatuses = onSnapshot(q, (snap) => {
        const now = Date.now();
        myStatuses = [];
        snap.forEach(d => {
          const data = { id: d.id, ...d.data() };
          if (toMillis(data.expiresAt) > now) myStatuses.push(data);
        });
        myStatuses.sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt));
        renderStatusStrip();
      });
    }

    function watchContactStatuses() {
      // Clean up listeners for contacts no longer in the list.
      const currentIds = new Set(contacts.map(c => c.uid));
      Object.keys(unsubContactStatuses).forEach(uid => {
        if (!currentIds.has(uid)) {
          unsubContactStatuses[uid]();
          delete unsubContactStatuses[uid];
        }
      });

      contacts.forEach(c => {
        if (unsubContactStatuses[c.uid]) return; // already watching
        const q = query(collection(db, "statuses"), where("uid", "==", c.uid));
        unsubContactStatuses[c.uid] = onSnapshot(q, (snap) => {
          const now = Date.now();
          const active = [];
          snap.forEach(d => {
            const data = { id: d.id, ...d.data() };
            if (toMillis(data.expiresAt) <= now) return; // expired
            if (Array.isArray(data.hiddenFrom) && data.hiddenFrom.includes(currentUserData.uid)) return; // hidden from me
            active.push(data);
          });
          active.sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt));

          const existingIdx = contactStatusGroups.findIndex(g => g.uid === c.uid);
          if (active.length === 0) {
            if (existingIdx !== -1) contactStatusGroups.splice(existingIdx, 1);
          } else {
            const group = { uid: c.uid, displayName: c.displayName, avatar: c.avatar, statuses: active };
            if (existingIdx !== -1) contactStatusGroups[existingIdx] = group;
            else contactStatusGroups.push(group);
          }
          renderStatusStrip();
        });
      });
    }

    function renderStatusStrip() {
      // Status now lives in its own bottom-nav tab as a row list (name +
      // last-updated), rather than a horizontal circle strip on Chats.
      const list = document.getElementById('status-strip-tab');
      if (!list) return;

      const myLatest = myStatuses.length > 0 ? myStatuses[myStatuses.length - 1] : null;
      const myRow = `
        <div class="w-full p-3 rounded-2xl bg-gray-900/40">
          <div class="flex items-center gap-3">
            <button onclick="${myStatuses.length ? 'openStatusViewerForMe()' : 'openPostStatus()'}" class="relative shrink-0" aria-label="View your statuses">
              <div class="w-14 h-14 rounded-full ${myStatuses.length ? 'p-0.5 bg-gradient-to-tr from-blue-500 to-teal-400' : ''} flex items-center justify-center">
                <div class="w-full h-full rounded-full bg-gray-800 flex items-center justify-center text-xl ${myStatuses.length ? '' : 'border-2 border-dashed border-gray-600'}">${currentUserData.avatar || '👤'}</div>
              </div>
            </button>
            <button onclick="openStatusViewerForMe()" class="min-w-0 text-left flex-1" ${myStatuses.length ? '' : 'disabled'}>
              <p class="font-medium">Your Status</p>
              <p class="text-xs text-gray-500 truncate">${myLatest ? `${myStatuses.length} update${myStatuses.length === 1 ? '' : 's'} · ${formatStatusTime(myLatest.createdAt)}` : 'No status yet'}</p>
            </button>
            <button onclick="openPostStatus()" class="shrink-0 px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-sm font-semibold">
              <i class="fas fa-plus mr-1"></i>Add
            </button>
          </div>
        </div>
      `;
      const contactRows = contactStatusGroups.map(g => {
        const latest = g.statuses[g.statuses.length - 1];
        return `
          <button onclick="openStatusViewer('${g.uid}')" class="w-full flex items-center gap-3 p-3 hover:bg-gray-800 rounded-2xl">
            <div class="w-14 h-14 rounded-full p-0.5 bg-gradient-to-tr from-teal-400 to-blue-500 shrink-0">
              <div class="w-full h-full rounded-full bg-gray-800 flex items-center justify-center text-xl">${g.avatar || '👤'}</div>
            </div>
            <div class="min-w-0 text-left">
              <p class="font-medium truncate">${escapeHtml(g.displayName)}</p>
              <p class="text-xs text-gray-500 truncate">${formatStatusTime(latest.createdAt)}</p>
            </div>
          </button>
        `;
      }).join('');

      list.innerHTML = myRow + (contactRows || `<p class="text-gray-500 text-sm text-center mt-8">No status updates from your contacts yet.</p>`);
    }

    function formatStatusTime(ts) {
      const ms = toMillis(ts);
      if (!ms) return '';
      const diffMin = Math.round((Date.now() - ms) / 60000);
      if (diffMin < 1) return 'Just now';
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHr = Math.round(diffMin / 60);
      if (diffHr < 24) return `${diffHr}h ago`;
      return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    // ---------- Posting a status ----------
    const STATUS_TEXT_BACKGROUNDS = [
      'linear-gradient(135deg,#1d4ed8,#0ea5e9)',
      'linear-gradient(135deg,#7c3aed,#db2777)',
      'linear-gradient(135deg,#059669,#0891b2)',
      'linear-gradient(135deg,#b45309,#dc2626)',
      'linear-gradient(135deg,#4b5563,#111827)',
      'linear-gradient(135deg,#be185d,#7c3aed)'
    ];
    let statusMode = 'media'; // 'media' | 'text'
    let statusTextBgIndex = 0;
    const MAX_STATUS_VIDEO_MB = 30;

    window.setStatusMode = function (mode) {
      statusMode = mode;
      const isMedia = mode === 'media';
      document.getElementById('status-media-area').classList.toggle('hidden', !isMedia);
      document.getElementById('status-text-area').classList.toggle('hidden', isMedia);
      const mediaBtn = document.getElementById('status-mode-media');
      const textBtn = document.getElementById('status-mode-text');
      mediaBtn.classList.toggle('bg-blue-600', isMedia);
      mediaBtn.classList.toggle('text-white', isMedia);
      textBtn.classList.toggle('bg-blue-600', !isMedia);
      textBtn.classList.toggle('text-white', !isMedia);
    };

    window.openPostStatus = function () {
      pendingStatusPhoto = null;
      pendingStatusVideo = null;
      statusHideFromSet = new Set();
      statusTextBgIndex = 0;
      document.getElementById('status-photo-preview').classList.add('hidden');
      document.getElementById('status-photo-preview-img').classList.add('hidden');
      document.getElementById('status-video-preview-vid').classList.add('hidden');
      document.getElementById('status-file-picker-btn').classList.remove('hidden');
      document.getElementById('status-caption-input').value = '';
      document.getElementById('status-text-input').value = '';
      document.getElementById('post-status-error').classList.add('hidden');
      document.getElementById('status-hide-count-label').textContent = 'Hide from no one';

      const bgPicker = document.getElementById('status-text-bg-picker');
      bgPicker.innerHTML = STATUS_TEXT_BACKGROUNDS.map((bg, i) => `
        <button onclick="selectStatusTextBg(${i})" data-status-bg="${i}"
                class="h-10 rounded-xl ${i === statusTextBgIndex ? 'ring-2 ring-white' : ''}" style="background:${bg}"></button>
      `).join('');

      setStatusMode('media');
      document.getElementById('post-status-modal').classList.remove('hidden');
    };

    window.selectStatusTextBg = function (i) {
      statusTextBgIndex = i;
      document.querySelectorAll('[data-status-bg]').forEach(btn => {
        btn.classList.toggle('ring-2', Number(btn.dataset.statusBg) === i);
        btn.classList.toggle('ring-white', Number(btn.dataset.statusBg) === i);
      });
    };

    window.closePostStatus = function () {
      document.getElementById('post-status-modal').classList.add('hidden');
    };

    window.handleStatusPhotoSelected = function (event) {
      const file = event.target.files[0];
      if (!file) return;

      if (file.type.startsWith('video/')) {
        if (file.size > MAX_STATUS_VIDEO_MB * 1024 * 1024) {
          alert(`That video is too large (max ${MAX_STATUS_VIDEO_MB}MB for a status).`);
          event.target.value = '';
          return;
        }
        pendingStatusVideo = file;
        pendingStatusPhoto = null;
        const vid = document.getElementById('status-video-preview-vid');
        vid.src = URL.createObjectURL(file);
        vid.classList.remove('hidden');
        document.getElementById('status-photo-preview-img').classList.add('hidden');
        document.getElementById('status-photo-preview').classList.remove('hidden');
        document.getElementById('status-file-picker-btn').classList.add('hidden');
        event.target.value = '';
        return;
      }

      if (!file.type.startsWith('image/')) {
        alert('Please choose an image or video file.');
        event.target.value = '';
        return;
      }
      pendingStatusPhoto = file;
      pendingStatusVideo = null;
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = document.getElementById('status-photo-preview-img');
        img.src = e.target.result;
        img.classList.remove('hidden');
        document.getElementById('status-video-preview-vid').classList.add('hidden');
        document.getElementById('status-photo-preview').classList.remove('hidden');
        document.getElementById('status-file-picker-btn').classList.add('hidden');
      };
      reader.readAsDataURL(file);
      event.target.value = '';
    };

    window.openStatusHidePicker = function () {
      const list = document.getElementById('status-hide-contacts-list');
      if (contacts.length === 0) {
        list.innerHTML = `<p class="text-xs text-gray-500 text-center py-4">No contacts yet.</p>`;
      } else {
        list.innerHTML = contacts.map(c => `
          <label class="flex items-center gap-3 p-2 hover:bg-gray-800 rounded-xl cursor-pointer">
            <input type="checkbox" ${statusHideFromSet.has(c.uid) ? 'checked' : ''} onchange="toggleStatusHideFrom('${c.uid}', this.checked)" class="w-4 h-4">
            <div class="w-8 h-8 bg-gray-700 rounded-xl flex items-center justify-center text-sm shrink-0">${c.avatar || '👤'}</div>
            <span class="text-sm truncate">${escapeHtml(c.displayName)}</span>
          </label>
        `).join('');
      }
      document.getElementById('status-hide-modal').classList.remove('hidden');
    };

    window.closeStatusHidePicker = function () {
      document.getElementById('status-hide-modal').classList.add('hidden');
      const n = statusHideFromSet.size;
      document.getElementById('status-hide-count-label').textContent =
        n === 0 ? 'Hide from no one' : `Hidden from ${n} contact${n === 1 ? '' : 's'}`;
    };

    window.toggleStatusHideFrom = function (uid, checked) {
      if (checked) statusHideFromSet.add(uid);
      else statusHideFromSet.delete(uid);
    };

    window.submitStatus = async function () {
      const errEl = document.getElementById('post-status-error');
      errEl.classList.add('hidden');

      const isTextMode = statusMode === 'text';
      let textValue = '';
      if (isTextMode) {
        textValue = document.getElementById('status-text-input').value.trim();
        if (!textValue) {
          errEl.textContent = 'Write something first.';
          errEl.classList.remove('hidden');
          return;
        }
      } else if (!pendingStatusPhoto && !pendingStatusVideo) {
        errEl.textContent = 'Choose a photo or video first.';
        errEl.classList.remove('hidden');
        return;
      }

      const btn = document.getElementById('submit-status-btn');
      const text = document.getElementById('submit-status-text');
      const spinner = document.getElementById('submit-status-spinner');
      btn.disabled = true;
      text.classList.add('hidden');
      spinner.classList.remove('hidden');

      try {
        const now = Date.now();
        const basePayload = {
          uid: currentUserData.uid,
          displayName: currentUserData.displayName,
          avatar: currentUserData.avatar || '👤',
          hiddenFrom: Array.from(statusHideFromSet),
          createdAt: serverTimestamp(),
          expiresAt: new Date(now + STATUS_DURATION_MS)
        };

        if (isTextMode) {
          await addDoc(collection(db, "statuses"), {
            ...basePayload,
            mediaType: 'text',
            text: textValue,
            bgIndex: statusTextBgIndex
          });
        } else {
          const file = pendingStatusPhoto || pendingStatusVideo;
          const mediaType = pendingStatusPhoto ? 'photo' : 'video';
          const formData = new FormData();
          formData.append('file', file);
          formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
          formData.append('folder', `status/${currentUserData.uid}`);
          const response = await fetch(CLOUDINARY_UPLOAD_URL, { method: 'POST', body: formData });
          if (!response.ok) throw new Error('Upload failed');
          const data = await response.json();

          await addDoc(collection(db, "statuses"), {
            ...basePayload,
            mediaType,
            mediaUrl: data.secure_url,
            caption: document.getElementById('status-caption-input').value.trim()
          });
        }

        closePostStatus();
      } catch (err) {
        errEl.textContent = 'Could not post — try again.';
        errEl.classList.remove('hidden');
        console.error(err);
      } finally {
        btn.disabled = false;
        text.classList.remove('hidden');
        spinner.classList.add('hidden');
      }
    };

    window.deleteMyStatus = async function () {
      const item = statusViewerQueue[statusViewerGroupIndex]?.statuses[statusViewerItemIndex];
      if (!item || item.uid !== currentUserData.uid) return;
      if (!confirm('Delete this status?')) return;
      await deleteDoc(doc(db, "statuses", item.id)).catch(() => {});
      // Move to next, or close if that was the last one.
      goToNextStatus();
    };

    // ---------- Status viewer ----------
    window.openStatusViewerForMe = function () {
      if (myStatuses.length === 0) { openPostStatus(); return; }
      statusViewerQueue = [{ uid: currentUserData.uid, displayName: 'Your Status', avatar: currentUserData.avatar || '👤', statuses: myStatuses }];
      statusViewerGroupIndex = 0;
      statusViewerItemIndex = 0;
      showCurrentStatusItem();
    };

    window.openStatusViewer = function (startUid) {
      statusViewerQueue = contactStatusGroups.slice();
      statusViewerGroupIndex = statusViewerQueue.findIndex(g => g.uid === startUid);
      if (statusViewerGroupIndex === -1) statusViewerGroupIndex = 0;
      statusViewerItemIndex = 0;
      showCurrentStatusItem();
    };

    function showCurrentStatusItem() {
      const group = statusViewerQueue[statusViewerGroupIndex];
      if (!group) { closeStatusViewer(); return; }
      const item = group.statuses[statusViewerItemIndex];
      if (!item) { closeStatusViewer(); return; }

      const modal = document.getElementById('status-viewer-modal');
      document.getElementById('status-viewer-avatar').textContent = group.avatar || '👤';
      document.getElementById('status-viewer-name').textContent = group.displayName;
      const ts = item.createdAt && item.createdAt.toDate ? item.createdAt.toDate() : new Date();
      document.getElementById('status-viewer-time').textContent = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const imgEl = document.getElementById('status-viewer-image');
      const vidEl = document.getElementById('status-viewer-video');
      const textEl = document.getElementById('status-viewer-text');
      imgEl.classList.add('hidden');
      vidEl.classList.add('hidden');
      vidEl.pause();
      vidEl.src = '';
      textEl.classList.add('hidden');
      textEl.style.background = '';

      const mediaType = item.mediaType || 'photo'; // older statuses predate the mediaType field
      if (mediaType === 'video') {
        vidEl.src = item.mediaUrl;
        vidEl.classList.remove('hidden');
      } else if (mediaType === 'text') {
        textEl.textContent = item.text || '';
        textEl.style.background = STATUS_TEXT_BACKGROUNDS[item.bgIndex] || STATUS_TEXT_BACKGROUNDS[0];
        textEl.classList.remove('hidden');
      } else {
        imgEl.src = item.mediaUrl;
        imgEl.classList.remove('hidden');
      }

      const captionEl = document.getElementById('status-viewer-caption');
      if (item.caption) { captionEl.textContent = item.caption; captionEl.classList.remove('hidden'); }
      else { captionEl.classList.add('hidden'); }

      const deleteBtn = document.getElementById('status-viewer-delete-btn');
      deleteBtn.classList.toggle('hidden', item.uid !== currentUserData.uid);

      // Photos and text statuses auto-advance after a fixed duration; videos
      // instead advance when playback ends (capped, in case a video is very
      // long or fails to fire 'ended' for some reason).
      const MAX_VIDEO_STATUS_SEC = 60;
      const durationSec = mediaType === 'video' ? MAX_VIDEO_STATUS_SEC : 5;

      // Progress bars: one segment per status in this person's group.
      const barsEl = document.getElementById('status-progress-bars');
      barsEl.innerHTML = group.statuses.map((_, i) => `
        <div class="flex-1 h-1 rounded-full bg-white/25 overflow-hidden">
          <div class="h-full bg-white rounded-full" style="width:${i < statusViewerItemIndex ? '100' : '0'}%; ${i === statusViewerItemIndex ? `animation: statusProgress ${durationSec}s linear forwards;` : ''}"></div>
        </div>
      `).join('');

      modal.classList.remove('hidden');
      modal.classList.add('flex');

      statusLocks.hold = false; statusLocks.tap = false; statusLocks.input = false;
      document.getElementById('status-paused-icon').classList.add('hidden');
      document.getElementById('status-viewer-modal').classList.remove('held');
      // Reply bar: only when viewing someone else's status.
      const replyBar = document.getElementById('status-reply-bar');
      const replyInput = document.getElementById('status-reply-input');
      replyInput.value = '';
      replyInput.placeholder = `Reply to ${group.displayName}…`;
      replyBar.classList.toggle('hidden', item.uid === currentUserData.uid);
      if (mediaType === 'video') {
        vidEl.onended = () => goToNextStatus();
        vidEl.play().catch(() => {}); // autoplay may be blocked until user interacts
        startStatusTimer(MAX_VIDEO_STATUS_SEC * 1000);
      } else {
        startStatusTimer(durationSec * 1000);
      }
    }

    window.goToNextStatus = function () {
      const group = statusViewerQueue[statusViewerGroupIndex];
      if (!group) { closeStatusViewer(); return; }
      if (statusViewerItemIndex < group.statuses.length - 1) {
        statusViewerItemIndex++;
      } else if (statusViewerGroupIndex < statusViewerQueue.length - 1) {
        statusViewerGroupIndex++;
        statusViewerItemIndex = 0;
      } else {
        closeStatusViewer();
        return;
      }
      showCurrentStatusItem();
    };

    window.goToPrevStatus = function () {
      if (statusViewerItemIndex > 0) {
        statusViewerItemIndex--;
      } else if (statusViewerGroupIndex > 0) {
        statusViewerGroupIndex--;
        statusViewerItemIndex = Math.max(0, statusViewerQueue[statusViewerGroupIndex].statuses.length - 1);
      } else {
        return; // already at the very first item
      }
      showCurrentStatusItem();
    };

    // ---- Pause / resume: hold your finger down to pause (release to continue), or tap the middle to pause/resume. ----
    function startStatusTimer(ms) {
      if (statusViewerTimer) clearTimeout(statusViewerTimer);
      statusTimerRemaining = ms;
      statusTimerStartedAt = Date.now();
      statusViewerTimer = setTimeout(goToNextStatus, ms);
    }
    function applyStatusPause() {
      const paused = statusLocks.hold || statusLocks.tap || statusLocks.input;
      const bar = document.querySelector('#status-progress-bars > div:nth-child(' + (statusViewerItemIndex + 1) + ') > div');
      const vid = document.getElementById('status-viewer-video');
      const videoShown = !vid.classList.contains('hidden');
      if (paused && statusViewerTimer) {
        clearTimeout(statusViewerTimer); statusViewerTimer = null;
        statusTimerRemaining = Math.max(300, statusTimerRemaining - (Date.now() - statusTimerStartedAt));
        if (bar) bar.style.animationPlayState = 'paused';
        if (videoShown) vid.pause();
      } else if (!paused && !statusViewerTimer && document.getElementById('status-viewer-modal').classList.contains('flex')) {
        startStatusTimer(statusTimerRemaining);
        if (bar) bar.style.animationPlayState = 'running';
        if (videoShown) vid.play().catch(() => {});
      }
      document.getElementById('status-paused-icon').classList.toggle('hidden', !statusLocks.tap);
    }
    window.statusLock = function (which, on) { statusLocks[which] = !!on; applyStatusPause(); };

    window.statusNavTap = function (e, dir) {
      e.stopPropagation();
      if (Date.now() < statusSuppressNavUntil) return; // that was a hold, not a tap
      if (statusLocks.tap) { statusLocks.tap = false; }
      if (dir === 'next') goToNextStatus(); else goToPrevStatus();
    };
    window.handleStatusViewerTap = function () {
      if (Date.now() < statusSuppressNavUntil) return;
      statusLocks.tap = !statusLocks.tap; // tap the middle: pause / resume
      applyStatusPause();
    };
    (function wireStatusHold() {
      const el = document.getElementById('status-viewer-content');
      const modal = document.getElementById('status-viewer-modal');
      if (!el) return;
      el.addEventListener('pointerdown', () => {
        statusHoldStart = Date.now();
        statusLocks.hold = true; modal.classList.add('held'); applyStatusPause();
      });
      const release = () => {
        if (!statusHoldStart) return;
        if (Date.now() - statusHoldStart > 250) statusSuppressNavUntil = Date.now() + 400;
        statusHoldStart = 0;
        statusLocks.hold = false; modal.classList.remove('held'); applyStatusPause();
      };
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => el.addEventListener(ev, release));
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    })();

    // ---- Reply to a status: arrives in the normal chat, quoting the status. ----
    window.sendStatusReply = async function () {
      const group = statusViewerQueue[statusViewerGroupIndex];
      const item = group && group.statuses[statusViewerItemIndex];
      const input = document.getElementById('status-reply-input');
      const text = input.value.trim();
      if (!item || !text || item.uid === currentUserData.uid) return;
      if (!contacts.some(c => c.uid === item.uid)) { alert('You can only reply to people in your contacts.'); return; }
      const mt = item.mediaType || 'photo';
      const preview = item.caption || (mt === 'text' ? (item.text || 'Status') : mt === 'video' ? '🎥 Video status' : '📷 Photo status');
      const ctx = { type: 'contact', otherUid: item.uid, path: ["chats", chatIdFor(item.uid), "messages"] };
      const replyTo = { messageId: '', text: preview.slice(0, 120), senderName: `${group.displayName}'s status` };
      input.value = '';
      input.blur();
      postMessage(ctx, buildMessagePayload(ctx, text, replyTo), text).catch(e => console.error('Status reply failed:', e));
      const icon = document.getElementById('status-paused-icon');
      icon.innerHTML = '<i class="fas fa-check"></i>';
      icon.classList.remove('hidden');
      setTimeout(() => { icon.classList.add('hidden'); icon.innerHTML = '<i class="fas fa-pause"></i>'; }, 900);
    };

    window.closeStatusViewer = function () {
      if (statusViewerTimer) { clearTimeout(statusViewerTimer); statusViewerTimer = null; }
      statusLocks.hold = statusLocks.tap = statusLocks.input = false;
      const vidEl = document.getElementById('status-viewer-video');
      vidEl.onended = null;
      vidEl.pause();
      document.getElementById('status-viewer-modal').classList.add('hidden');
      document.getElementById('status-viewer-modal').classList.remove('flex');
    };

    // ==========================================================
    // CALLING (WebRTC + Firestore signaling)
    //
    // Data model: a doc in "calls/{callId}" holds the offer/answer SDP
    // and status. Two subcollections, "callerCandidates" and
    // "calleeCandidates", hold ICE candidates as they trickle in.
    // Uses Metered.ca TURN + STUN (RTC_CONFIG above) so calls can
    // connect even when both people are on different/restrictive
    // networks (mobile data, carrier-grade NAT, etc).
    // ==========================================================

    function callDocId(uidA, uidB) {
      return 'call_' + [uidA, uidB].sort().join('_');
    }

    // ---------- Call History ----------
    // Each side writes its own entry to users/{uid}/callHistory/{id} so the
    // log always reflects "my" perspective (outgoing vs incoming) and needs
    // no extra permissions to read the other person's data.
    let callHistoryUnsub = null;
    let callHistoryEntries = [];
    let currentCallStartedAt = null;   // ms, set once status becomes 'connected'
    let currentCallPeerForLog = null;  // { uid, displayName, avatar } of the other party in the active call

    async function logCallHistory(peerUser, direction, type, outcome, durationSec) {
      // direction: 'outgoing' | 'incoming'. outcome: 'answered' | 'missed' | 'declined'.
      try {
        const ref = await addDoc(collection(db, "users", currentUserData.uid, "callHistory"), {
          peerUid: peerUser.uid,
          peerName: peerUser.displayName,
          peerAvatar: peerUser.avatar || '👤',
          direction,
          type,
          outcome,
          durationSec: durationSec || 0,
          createdAt: serverTimestamp()
        });
        return ref;
      } catch (err) {
        console.error('Failed to log call history', err);
        return null;
      }
    }

    function listenToCallHistory() {
      if (callHistoryUnsub) callHistoryUnsub();
      const q = query(
        collection(db, "users", currentUserData.uid, "callHistory"),
        orderBy("createdAt", "desc"),
        limit(100)
      );
      callHistoryUnsub = onSnapshot(q, (snap) => {
        callHistoryEntries = [];
        snap.forEach(d => callHistoryEntries.push({ id: d.id, ...d.data() }));
        renderCallHistory();
      });
    }

    function renderCallHistory() {
      const list = document.getElementById('call-history-list');
      const empty = document.getElementById('call-history-empty');
      if (!list) return;

      if (callHistoryEntries.length === 0) {
        list.innerHTML = '';
        empty?.classList.remove('hidden');
        return;
      }
      empty?.classList.add('hidden');

      list.innerHTML = callHistoryEntries.map(e => {
        const missedOrDeclined = e.outcome === 'missed' || e.outcome === 'declined';
        const icon = e.direction === 'outgoing' ? 'fa-arrow-up' : 'fa-arrow-down';
        const color = missedOrDeclined ? 'text-red-400' : (e.direction === 'outgoing' ? 'text-teal-400' : 'text-green-400');
        const label = e.outcome === 'missed' ? 'Missed' : e.outcome === 'declined' ? 'Declined' : (e.direction === 'outgoing' ? 'Outgoing' : 'Incoming');
        const durationLabel = e.outcome === 'answered' && e.durationSec > 0 ? ` · ${formatCallDuration(e.durationSec)}` : '';
        const typeIcon = e.type === 'video' ? 'fa-video' : 'fa-phone';
        return `
          <div class="flex items-center gap-3 p-3 hover:bg-gray-800 rounded-2xl">
            <div class="w-11 h-11 bg-gray-700 rounded-2xl flex items-center justify-center text-xl shrink-0">${e.peerAvatar || '👤'}</div>
            <div class="flex-1 min-w-0 cursor-pointer" onclick="openChatFromCallHistory('${e.peerUid}')">
              <p class="font-medium truncate">${escapeHtml(e.peerName || 'Unknown')}</p>
              <p class="text-xs ${color} flex items-center gap-1">
                <i class="fas ${icon} text-[10px]"></i>
                ${label}${durationLabel}
                <span class="text-gray-500">· ${formatStatusTime(e.createdAt)}</span>
              </p>
            </div>
            <button onclick="redialFromHistory('${e.peerUid}', '${e.type}')" title="Call ${escapeHtml(e.peerName || '')}" class="w-9 h-9 rounded-full bg-gray-800 hover:bg-gray-700 flex items-center justify-center text-blue-400 shrink-0">
              <i class="fas ${typeIcon}"></i>
            </button>
          </div>
        `;
      }).join('');
    }

    function formatCallDuration(sec) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m > 0 ? `${m}m ${s}s` : `${s}s`;
    }

    window.openChatFromCallHistory = function (peerUid) {
      const user = contacts.find(c => c.uid === peerUid);
      if (!user) { alert('This contact is no longer in your contacts.'); return; }
      openChatWith(peerUid);
    };

    window.redialFromHistory = function (peerUid, type) {
      const user = contacts.find(c => c.uid === peerUid);
      if (!user) { alert('This contact is no longer in your contacts.'); return; }
      activeChatType = 'contact';
      activeChatUser = user;
      activeGroup = null;
      startCall(type === 'video' ? 'video' : 'voice');
    };

    window.openCallsNewCallPicker = function () {
      // Simplest entry point: send them to Chats to pick who to call —
      // avoids duplicating the contact list UI in a second place.
      switchTab(0);
    };

    // Listen for an incoming call ringing for me, from any accepted contact.
    function listenForIncomingCalls() {
      const q = query(collection(db, "calls"), where("calleeId", "==", currentUserData.uid), where("status", "==", "ringing"));
      unsubIncomingCalls = onSnapshot(q, (snap) => {
        snap.forEach(d => {
          if (currentCallId) return; // already in a call, ignore for now
          const call = d.data();
          // Ignore old "ringing" calls that were never closed (caller lost signal / closed the app).
          const startedMs = call.createdAt && call.createdAt.toMillis ? call.createdAt.toMillis() : Date.now();
          if (Date.now() - startedMs > 60 * 1000) return;
          showIncomingCall(d.id, call);
        });
      });
    }

    function showIncomingCall(callId, call) {
      currentCallId = callId;
      currentCallType = call.type;
      callRole = 'callee';
      currentCallPeerForLog = { uid: call.callerId, displayName: call.callerName, avatar: call.callerAvatar };

      const overlay = document.getElementById('call-overlay');
      document.getElementById('call-peer-avatar').textContent = call.callerAvatar || '👤';
      document.getElementById('call-peer-name').textContent = call.callerName || 'Unknown';
      document.getElementById('call-status-text').textContent = call.type === 'video' ? 'Incoming video call...' : 'Incoming voice call...';
      document.getElementById('call-accept-btn').classList.remove('hidden');
      document.getElementById('call-accept-btn').classList.add('flex');
      document.getElementById('call-mute-btn').classList.add('hidden');
      document.getElementById('call-video-toggle-btn').classList.add('hidden');
      document.getElementById('remote-video').classList.add('hidden');
      document.getElementById('local-video').classList.add('hidden');
      overlay.classList.remove('hidden');
      overlay.classList.add('flex');

      // Watch the call doc in case the caller hangs up before we answer
      if (unsubCallDoc) unsubCallDoc();
      unsubCallDoc = onSnapshot(doc(db, "calls", callId), (d) => {
        if (!d.exists() || d.data().status === 'ended' || d.data().status === 'declined') {
          if (currentCallId === callId && callRole === 'callee' && !peerConnection) {
            // Never answered — log as missed (the caller hung up first, or it timed out).
            const peer = { uid: call.callerId, displayName: call.callerName, avatar: call.callerAvatar };
            logCallHistory(peer, 'incoming', call.type, 'missed', 0);
            currentCallPeerForLog = null; // already logged above — don't let teardownCall log again
            teardownCall();
          }
        }
      });
    }

    window.startCall = async function (type) {
      if (!isServerReachable()) { alert("You're not connected yet. Wait for the green 'Connected' bar, then try the call again."); return; }
      if (activeChatType === 'group' && activeGroup) { return startGroupCall(type); }
      if (!activeChatUser) return;
      if (currentCallId) { alert('Already in a call.'); return; }

      currentCallType = type;
      callRole = 'caller';
      const callId = callDocId(currentUserData.uid, activeChatUser.uid);
      currentCallId = callId;
      currentCallPeerForLog = { uid: activeChatUser.uid, displayName: activeChatUser.displayName, avatar: activeChatUser.avatar };

      // Check for mic/camera support before touching the UI at all —
      // some iOS Safari contexts (e.g. certain PWA/standalone modes) don't
      // expose navigator.mediaDevices, and calling into it directly can
      // destabilize the page instead of throwing a catchable error.
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Calling isn\'t supported in this browser mode. Try opening the site directly in Safari (not from the home screen icon) and try again.');
        currentCallId = null;
        callRole = null;
        currentCallType = null;
        return;
      }

      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: type === 'video' ? { facingMode: 'user' } : false
        });
      } catch (err) {
        alert('Could not access microphone/camera. Check that you allowed permission when prompted, or check Settings > Safari > Camera & Microphone.');
        currentCallId = null;
        callRole = null;
        currentCallType = null;
        return;
      }

      // Only now, with permission confirmed, show the full call UI.
      const overlay = document.getElementById('call-overlay');
      document.getElementById('call-peer-avatar').textContent = activeChatUser.avatar || '👤';
      document.getElementById('call-peer-name').textContent = activeChatUser.displayName;
      document.getElementById('call-status-text').textContent = 'Calling...';
      document.getElementById('call-accept-btn').classList.add('hidden');
      document.getElementById('call-mute-btn').classList.remove('hidden');
      document.getElementById('call-mute-btn').classList.add('flex');
      if (type === 'video') {
        document.getElementById('call-video-toggle-btn').classList.remove('hidden');
        document.getElementById('call-video-toggle-btn').classList.add('flex');
      }
      overlay.classList.remove('hidden');
      overlay.classList.add('flex');

      setupLocalMediaPreview();
      peerConnection = new RTCPeerConnection(RTC_CONFIG);
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
      wireRemoteTrackHandler();

      const callerCandidatesCol = collection(db, "calls", callId, "callerCandidates");
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) addDoc(callerCandidatesCol, event.candidate.toJSON());
      };

      const offerDescription = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offerDescription);

      await setDoc(doc(db, "calls", callId), {
        callerId: currentUserData.uid,
        callerName: currentUserData.displayName,
        callerAvatar: currentUserData.avatar || '👤',
        calleeId: activeChatUser.uid,
        type,
        status: 'ringing',
        offer: { type: offerDescription.type, sdp: offerDescription.sdp },
        createdAt: serverTimestamp()
      });

      // Nobody picked up within 45s (or they have no signal): stop ringing instead of calling forever.
      clearTimeout(callRingTimeout);
      callRingTimeout = setTimeout(() => {
        if (currentCallId === callId && callRole === 'caller' && !currentCallStartedAt) {
          document.getElementById('call-status-text').textContent = 'No answer';
          updateDoc(doc(db, "calls", callId), { status: 'ended' }).catch(() => {});
          setTimeout(() => { if (currentCallId === callId) teardownCall(); }, 1500);
        }
      }, 45000);

      // Listen for the answer + status changes
      const calleeForLog = { uid: activeChatUser.uid, displayName: activeChatUser.displayName, avatar: activeChatUser.avatar };
      if (unsubCallDoc) unsubCallDoc();
      unsubCallDoc = onSnapshot(doc(db, "calls", callId), async (d) => {
        if (!d.exists()) return;
        const data = d.data();
        if (data.status === 'declined') {
          document.getElementById('call-status-text').textContent = 'Declined';
          if (currentCallId === callId) {
            logCallHistory(calleeForLog, 'outgoing', type, 'declined', 0);
            currentCallPeerForLog = null; // already logged above — don't let teardownCall log again
          }
          setTimeout(() => teardownCall(), 1200);
        } else if (data.status === 'ended') {
          teardownCall();
        } else if (data.answer && peerConnection && !peerConnection.currentRemoteDescription) {
          const answerDescription = new RTCSessionDescription(data.answer);
          await peerConnection.setRemoteDescription(answerDescription);
          clearTimeout(callRingTimeout);
          document.getElementById('call-status-text').textContent = type === 'video' ? 'Video call' : 'Voice call';
          currentCallStartedAt = Date.now();
        }
      });

      // Listen for callee's ICE candidates
      if (unsubIceCandidates) unsubIceCandidates();
      unsubIceCandidates = onSnapshot(collection(db, "calls", callId, "calleeCandidates"), (snap) => {
        snap.docChanges().forEach(change => {
          if (change.type === 'added' && peerConnection) {
            peerConnection.addIceCandidate(new RTCIceCandidate(change.doc.data()));
          }
        });
      });
    };

    window.acceptCall = async function () {
      if (groupCall && !groupCall.joined) { return joinGroupCall(); }
      if (!currentCallId) return;
      const callId = currentCallId;
      const callSnap = await getDoc(doc(db, "calls", callId));
      if (!callSnap.exists()) { teardownCall(); return; }
      const call = callSnap.data();

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Calling isn\'t supported in this browser mode. Try opening the site directly in Safari (not from the home screen icon) and try again.');
        await updateDoc(doc(db, "calls", callId), { status: 'declined' });
        teardownCall();
        return;
      }

      document.getElementById('call-status-text').textContent = call.type === 'video' ? 'Video call' : 'Voice call';
      document.getElementById('call-accept-btn').classList.add('hidden');
      document.getElementById('call-mute-btn').classList.remove('hidden');
      document.getElementById('call-mute-btn').classList.add('flex');
      if (call.type === 'video') {
        document.getElementById('call-video-toggle-btn').classList.remove('hidden');
        document.getElementById('call-video-toggle-btn').classList.add('flex');
      }

      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: call.type === 'video' ? { facingMode: 'user' } : false
        });
      } catch (err) {
        alert('Could not access microphone/camera. Check permissions.');
        await updateDoc(doc(db, "calls", callId), { status: 'declined' });
        teardownCall();
        return;
      }

      setupLocalMediaPreview();
      peerConnection = new RTCPeerConnection(RTC_CONFIG);
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
      wireRemoteTrackHandler();

      const calleeCandidatesCol = collection(db, "calls", callId, "calleeCandidates");
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) addDoc(calleeCandidatesCol, event.candidate.toJSON());
      };

      await peerConnection.setRemoteDescription(new RTCSessionDescription(call.offer));
      const answerDescription = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answerDescription);

      await updateDoc(doc(db, "calls", callId), {
        status: 'connected',
        answer: { type: answerDescription.type, sdp: answerDescription.sdp }
      });

      // Listen for caller's ICE candidates + end/decline
      if (unsubIceCandidates) unsubIceCandidates();
      unsubIceCandidates = onSnapshot(collection(db, "calls", callId, "callerCandidates"), (snap) => {
        snap.docChanges().forEach(change => {
          if (change.type === 'added' && peerConnection) {
            peerConnection.addIceCandidate(new RTCIceCandidate(change.doc.data()));
          }
        });
      });

      if (unsubCallDoc) unsubCallDoc();
      unsubCallDoc = onSnapshot(doc(db, "calls", callId), (d) => {
        if (!d.exists() || d.data().status === 'ended') teardownCall();
      });
    };

    function setupLocalMediaPreview() {
      const localVideo = document.getElementById('local-video');
      if (currentCallType === 'video') {
        localVideo.srcObject = localStream;
        localVideo.classList.remove('hidden');
      } else {
        localVideo.classList.add('hidden');
      }
    }

    function wireRemoteTrackHandler() {
      const remoteVideo = document.getElementById('remote-video');
      const remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
      peerConnection.ontrack = (event) => {
        const src = (event.streams && event.streams[0]) ? event.streams[0].getTracks() : [event.track];
        src.forEach(track => { if (!remoteStream.getTracks().includes(track)) remoteStream.addTrack(track); });
        if (currentCallType === 'video') {
          remoteVideo.classList.remove('hidden');
          const wrap = document.getElementById('call-avatar-wrap');
          if (wrap) wrap.classList.add('hidden');
        }
        // iOS needs an explicit play() once the stream has tracks.
        remoteVideo.play().catch(() => {});
      };
      peerConnection.onconnectionstatechange = () => {
        if (!peerConnection) return;
        const statusEl = document.getElementById('call-status-text');
        const state = peerConnection.connectionState;
        if (state === 'connecting' || state === 'new') {
          if (statusEl) statusEl.textContent = 'Connecting...';
        } else if (state === 'connected') {
          if (statusEl) statusEl.textContent = currentCallType === 'video' ? 'Video call' : 'Voice call';
        } else if (state === 'disconnected' || state === 'failed') {
          if (statusEl) statusEl.textContent = 'Connection failed — try a different network';
          setTimeout(() => teardownCall(), 2500);
        }
      };
    }

    window.toggleMute = function () {
      if (!localStream) return;
      isMuted = !isMuted;
      localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
      const btn = document.getElementById('call-mute-btn');
      btn.innerHTML = isMuted ? '<i class="fas fa-microphone-slash"></i>' : '<i class="fas fa-microphone"></i>';
      btn.classList.toggle('bg-red-600', isMuted);
    };

    window.toggleCamera = function () {
      if (!localStream) return;
      isCameraOff = !isCameraOff;
      localStream.getVideoTracks().forEach(t => t.enabled = !isCameraOff);
      const btn = document.getElementById('call-video-toggle-btn');
      btn.innerHTML = isCameraOff ? '<i class="fas fa-video-slash"></i>' : '<i class="fas fa-video"></i>';
      btn.classList.toggle('bg-red-600', isCameraOff);
    };

    window.endCall = async function () {
      if (groupCall) { await leaveGroupCall(); return; }
      if (currentCallId) {
        try {
          const callSnap = await getDoc(doc(db, "calls", currentCallId));
          if (callSnap.exists()) {
            const wasRinging = callSnap.data().status === 'ringing' && callRole === 'callee';
            await updateDoc(doc(db, "calls", currentCallId), { status: wasRinging ? 'declined' : 'ended' });
          }
        } catch (err) { /* doc may already be gone */ }
      }
      teardownCall();
    };

    let callRingTimeout = null;
    function teardownCall() {
      clearTimeout(callRingTimeout); callRingTimeout = null;
      // Log this call to history before clearing state, unless it was
      // already logged elsewhere (declined-by-callee, or missed-while-ringing
      // paths log themselves and null out currentCallPeerForLog first).
      if (currentCallId && currentCallPeerForLog && callRole) {
        const direction = callRole === 'caller' ? 'outgoing' : 'incoming';
        const outcome = currentCallStartedAt ? 'answered' : (direction === 'outgoing' ? 'missed' : 'missed');
        const durationSec = currentCallStartedAt ? Math.round((Date.now() - currentCallStartedAt) / 1000) : 0;
        // Skip logging "missed" here for an outgoing call — that case (never
        // answered) usually means the callee declined or ignored it, and is
        // already logged by the callee's own device from their side; logging
        // it again here as an unconnected outgoing call would double up
        // confusingly, so only log outgoing once it actually connected.
        if (direction === 'incoming' || outcome === 'answered') {
          logCallHistory(currentCallPeerForLog, direction, currentCallType || 'voice', outcome, durationSec);
        }
      }

      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
      }
      if (unsubCallDoc) { unsubCallDoc(); unsubCallDoc = null; }
      if (unsubIceCandidates) { unsubIceCandidates(); unsubIceCandidates = null; }

      const remoteVideo = document.getElementById('remote-video');
      const localVideo = document.getElementById('local-video');
      remoteVideo.srcObject = null;
      localVideo.srcObject = null;
      remoteVideo.classList.add('hidden');
      localVideo.classList.add('hidden');
      const avWrap = document.getElementById('call-avatar-wrap');
      if (avWrap) avWrap.classList.remove('hidden');

      document.getElementById('call-overlay').classList.add('hidden');
      document.getElementById('call-overlay').classList.remove('flex');
      document.getElementById('call-mute-btn').classList.add('hidden');
      document.getElementById('call-video-toggle-btn').classList.add('hidden');
      document.getElementById('call-accept-btn').classList.add('hidden');
      document.getElementById('call-mute-btn').innerHTML = '<i class="fas fa-microphone"></i>';
      document.getElementById('call-mute-btn').classList.remove('bg-red-600');
      document.getElementById('call-video-toggle-btn').innerHTML = '<i class="fas fa-video"></i>';
      document.getElementById('call-video-toggle-btn').classList.remove('bg-red-600');

      currentCallId = null;
      currentCallType = null;
      callRole = null;
      isMuted = false;
      isCameraOff = false;
      currentCallStartedAt = null;
      currentCallPeerForLog = null;
    }

    // ==========================================================
    // GROUP CALLS (voice + video), up to GROUP_CALL_MAX people.
    //
    // "Mesh": every person connects directly to every other person (a normal
    // WebRTC connection per pair), so no media server is needed. That is fine
    // for small groups; quality drops past ~6 people because each phone has to
    // upload its video once per person.
    //
    // Signalling goes through Firestore:
    //   groupCalls/{groupId}                 who is in the call (participants), type, status
    //   groupCalls/{groupId}/signals/{id}    {from, to, kind: offer|answer|candidate, data}
    // The person with the lower uid of each pair makes the offer, so two people
    // joining at the same moment never clash.
    // ==========================================================
    const GROUP_CALL_MAX = 6;
    let groupCall = null;          // { gid, group, type, joined, sessionId, peers: Map, unsubDoc, unsubSignals, heartbeat }
    let unsubGroupCalls = null;
    const dismissedGroupCalls = new Set();

    function groupMemberInfo(group, uid) {
      return (group.memberInfo && group.memberInfo[uid]) || contacts.find(c => c.uid === uid) || { displayName: 'Member', avatar: '👤' };
    }

    function listenForGroupCalls() {
      if (unsubGroupCalls) unsubGroupCalls();
      const q = query(collection(db, "groupCalls"), where("members", "array-contains", currentUserData.uid));
      unsubGroupCalls = onSnapshot(q, (snap) => {
        snap.forEach(d => {
          const c = d.data();
          if (c.status !== 'active') return;
          if ((c.participants || []).includes(currentUserData.uid)) return;
          if ((c.participants || []).length === 0) return;
          if (currentCallId || groupCall) return;
          if (dismissedGroupCalls.has(c.sessionId)) return;
          const updated = c.updatedAt && c.updatedAt.toMillis ? c.updatedAt.toMillis() : Date.now();
          if (Date.now() - updated > 90 * 1000) return; // stale: nobody is keeping it alive
          showIncomingGroupCall(d.id, c);
        });
        // The call we were being rung for has ended.
        if (groupCall && !groupCall.joined) {
          const cur = snap.docs.find(d => d.id === groupCall.gid);
          if (!cur || cur.data().status !== 'active' || !(cur.data().participants || []).length) groupCleanup();
        }
      }, (err) => console.error('Group call listener:', err));
    }

    function showGroupCallOverlay(title, statusText, incoming) {
      const overlay = document.getElementById('call-overlay');
      document.getElementById('call-peer-avatar').textContent = '👥';
      document.getElementById('call-peer-name').textContent = title;
      document.getElementById('call-status-text').textContent = statusText;
      const accept = document.getElementById('call-accept-btn');
      accept.classList.toggle('hidden', !incoming);
      accept.classList.toggle('flex', incoming);
      document.getElementById('call-mute-btn').classList.toggle('hidden', incoming);
      document.getElementById('call-mute-btn').classList.toggle('flex', !incoming);
      const vbtn = document.getElementById('call-video-toggle-btn');
      const showVideoBtn = !incoming && groupCall && groupCall.type === 'video';
      vbtn.classList.toggle('hidden', !showVideoBtn);
      vbtn.classList.toggle('flex', !!showVideoBtn);
      overlay.classList.remove('hidden');
      overlay.classList.add('flex');
    }

    function showIncomingGroupCall(gid, c) {
      const group = groups.find(g => g.id === gid);
      if (!group) return;
      groupCall = { gid, group, type: c.type, joined: false, sessionId: c.sessionId, peers: new Map() };
      currentCallId = 'group_' + gid; // blocks 1-on-1 calls while this is open
      document.getElementById('remote-video').classList.add('hidden');
      document.getElementById('local-video').classList.add('hidden');
      showGroupCallOverlay(group.name || 'Group', `${c.startedByName || 'Someone'} started a group ${c.type === 'video' ? 'video' : 'voice'} call`, true);
      // If nobody answers, stop ringing after a while.
      groupCall.ringTimeout = setTimeout(() => { if (groupCall && !groupCall.joined) { dismissedGroupCalls.add(groupCall.sessionId); groupCleanup(); } }, 60000);
    }

    async function getGroupCallMedia(type) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("Calling isn't supported in this browser mode. Try opening the site directly in Safari.");
        return null;
      }
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' ? { facingMode: 'user' } : false });
      } catch (e) {
        alert('Could not access microphone/camera. Check the permission in your browser settings.');
        return null;
      }
    }

    async function startGroupCall(type) {
      if (!activeGroup) return;
      if (currentCallId || groupCall) { alert('Already in a call.'); return; }
      const group = activeGroup;
      if ((group.members || []).length < 2) { alert('Add someone to this group first.'); return; }
      localStream = await getGroupCallMedia(type);
      if (!localStream) return;
      const sessionId = 'gc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      groupCall = { gid: group.id, group, type, joined: true, sessionId, peers: new Map() };
      currentCallId = 'group_' + group.id;
      try {
        await setDoc(doc(db, "groupCalls", group.id), {
          sessionId, groupId: group.id, groupName: group.name || 'Group', type,
          startedBy: currentUserData.uid, startedByName: currentUserData.displayName || 'Someone',
          members: group.members, participants: [currentUserData.uid], status: 'active',
          updatedAt: serverTimestamp()
        });
      } catch (e) {
        console.error('Could not start group call:', e);
        alert('Could not start the group call.');
        groupCleanup();
        return;
      }
      beginGroupCallSession();
    }

    async function joinGroupCall() {
      if (!groupCall || groupCall.joined) return;
      clearTimeout(groupCall.ringTimeout);
      const snap = await getDoc(doc(db, "groupCalls", groupCall.gid));
      if (!snap.exists() || snap.data().status !== 'active') { alert('That call has ended.'); groupCleanup(); return; }
      if ((snap.data().participants || []).length >= GROUP_CALL_MAX) { alert(`This call is full (${GROUP_CALL_MAX} people).`); groupCleanup(); return; }
      groupCall.type = snap.data().type;
      localStream = await getGroupCallMedia(groupCall.type);
      if (!localStream) { dismissedGroupCalls.add(groupCall.sessionId); groupCleanup(); return; }
      groupCall.joined = true;
      try {
        await updateDoc(doc(db, "groupCalls", groupCall.gid), { participants: arrayUnion(currentUserData.uid), updatedAt: serverTimestamp() });
      } catch (e) { console.error('Join failed:', e); alert('Could not join the call.'); groupCleanup(); return; }
      beginGroupCallSession();
    }

    async function beginGroupCallSession() {
      const gc = groupCall;
      const me = currentUserData.uid;
      showGroupCallOverlay(gc.group.name || 'Group', 'Group call', false);
      document.getElementById('remote-video').classList.add('hidden');
      const avWrap = document.getElementById('call-avatar-wrap'); if (avWrap) avWrap.classList.add('hidden');
      const grid = document.getElementById('group-call-grid');
      grid.classList.remove('hidden');
      grid.innerHTML = '';
      const lv = document.getElementById('local-video');
      if (gc.type === 'video') { lv.srcObject = localStream; lv.classList.remove('hidden'); } else lv.classList.add('hidden');

      // Clear old signals addressed to me (from a previous call), then listen for new ones.
      try {
        const old = await getDocs(query(collection(db, "groupCalls", gc.gid, "signals"), where("to", "==", me)));
        await Promise.all(old.docs.map(d => deleteDoc(d.ref).catch(() => {})));
      } catch (_) {}
      if (groupCall !== gc) return;

      gc.unsubSignals = onSnapshot(query(collection(db, "groupCalls", gc.gid, "signals"), where("to", "==", me)), (snap) => {
        snap.docChanges().forEach(ch => { if (ch.type === 'added') handleGroupSignal(ch.doc.id, ch.doc.data()); });
      }, (err) => console.error('Signal listener:', err));

      gc.unsubDoc = onSnapshot(doc(db, "groupCalls", gc.gid), (d) => {
        if (groupCall !== gc) return;
        if (!d.exists() || d.data().status !== 'active') { groupCleanup(); return; }
        const parts = (d.data().participants || []).filter(u => u !== me);
        // New people: the lower uid makes the offer.
        parts.forEach(uid => {
          if (!gc.peers.has(uid)) {
            ensureGroupPeer(uid);
            if (me < uid) makeGroupOffer(uid);
          }
        });
        // People who left.
        [...gc.peers.keys()].forEach(uid => { if (!parts.includes(uid)) removeGroupPeer(uid); });
        updateGroupGridLayout();
        const status = document.getElementById('call-status-text');
        if (status) status.textContent = `Group call · ${parts.length + 1} in call`;
      }, (err) => console.error('Group call doc listener:', err));

      // Keep the call "fresh" so late joiners can see it's still live.
      gc.heartbeat = setInterval(() => {
        updateDoc(doc(db, "groupCalls", gc.gid), { updatedAt: serverTimestamp() }).catch(() => {});
      }, 30000);
    }

    function ensureGroupPeer(uid) {
      const gc = groupCall;
      if (gc.peers.has(uid)) return gc.peers.get(uid);
      const info = groupMemberInfo(gc.group, uid);
      const peer = { uid, pc: null, pending: [], stream: new MediaStream(), tile: null };
      const tile = document.createElement('div');
      tile.className = 'gc-tile';
      tile.innerHTML = `<div class="gc-avatar"><div>${escapeHtml(info.avatar || '👤')}</div></div>
        <video autoplay playsinline class="${gc.type === 'video' ? '' : 'hidden'}"></video>
        <div class="gc-name">${escapeHtml(info.displayName || 'Member')}</div>
        <div class="gc-state">connecting…</div>`;
      peer.tile = tile;
      peer.video = tile.querySelector('video');
      peer.video.srcObject = peer.stream;
      document.getElementById('group-call-grid').appendChild(tile);

      const pc = new RTCPeerConnection(RTC_CONFIG);
      peer.pc = pc;
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      pc.onicecandidate = (e) => {
        if (e.candidate) sendGroupSignal(uid, 'candidate', JSON.stringify(e.candidate.toJSON()));
      };
      pc.ontrack = (e) => {
        const tracks = (e.streams && e.streams[0]) ? e.streams[0].getTracks() : [e.track];
        tracks.forEach(t => { if (!peer.stream.getTracks().includes(t)) peer.stream.addTrack(t); });
        if (gc.type === 'video' && peer.stream.getVideoTracks().length) {
          peer.video.classList.remove('hidden');
          tile.querySelector('.gc-avatar').classList.add('hidden');
        }
        peer.video.play().catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        const st = tile.querySelector('.gc-state');
        if (!st) return;
        if (pc.connectionState === 'connected') st.textContent = '';
        else if (pc.connectionState === 'failed') st.textContent = 'connection failed';
        else if (pc.connectionState === 'disconnected') st.textContent = 'reconnecting…';
        else st.textContent = 'connecting…';
      };
      gc.peers.set(uid, peer);
      return peer;
    }

    function removeGroupPeer(uid) {
      const gc = groupCall; if (!gc) return;
      const peer = gc.peers.get(uid); if (!peer) return;
      try { peer.pc.close(); } catch (_) {}
      if (peer.tile) peer.tile.remove();
      gc.peers.delete(uid);
    }

    function sendGroupSignal(toUid, kind, data) {
      if (!groupCall) return;
      addDoc(collection(db, "groupCalls", groupCall.gid, "signals"), {
        from: currentUserData.uid, to: toUid, kind, data, createdAt: serverTimestamp()
      }).catch(e => console.error('Signal send failed:', e));
    }

    async function makeGroupOffer(uid) {
      try {
        const peer = ensureGroupPeer(uid);
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        sendGroupSignal(uid, 'offer', JSON.stringify({ type: offer.type, sdp: offer.sdp }));
      } catch (e) { console.error('Offer failed:', e); }
    }

    async function handleGroupSignal(sigId, s) {
      const gc = groupCall;
      if (!gc || !gc.joined) return;
      try {
        if (s.kind === 'offer') {
          const peer = ensureGroupPeer(s.from);
          await peer.pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(s.data)));
          for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          sendGroupSignal(s.from, 'answer', JSON.stringify({ type: answer.type, sdp: answer.sdp }));
        } else if (s.kind === 'answer') {
          const peer = gc.peers.get(s.from);
          if (peer && !peer.pc.currentRemoteDescription) {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(s.data)));
            for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
          }
        } else if (s.kind === 'candidate') {
          const peer = ensureGroupPeer(s.from);
          const cand = new RTCIceCandidate(JSON.parse(s.data));
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(cand).catch(() => {});
          else peer.pending.push(cand);
        }
      } catch (e) { console.error('Handling signal failed:', e); }
      deleteDoc(doc(db, "groupCalls", gc.gid, "signals", sigId)).catch(() => {});
    }

    function updateGroupGridLayout() {
      const grid = document.getElementById('group-call-grid');
      grid.style.gridTemplateColumns = grid.children.length <= 1 ? '1fr' : 'repeat(2, 1fr)';
    }

    async function leaveGroupCall() {
      const gc = groupCall; if (!gc) return;
      if (!gc.joined) { // just declining the ring
        dismissedGroupCalls.add(gc.sessionId);
        groupCleanup();
        return;
      }
      const gid = gc.gid;
      groupCleanup();
      try {
        await updateDoc(doc(db, "groupCalls", gid), { participants: arrayRemove(currentUserData.uid), updatedAt: serverTimestamp() });
        const snap = await getDoc(doc(db, "groupCalls", gid));
        if (snap.exists() && (snap.data().participants || []).length === 0) {
          await updateDoc(doc(db, "groupCalls", gid), { status: 'ended' });
        }
      } catch (e) { console.error('Leave failed:', e); }
    }

    function groupCleanup() {
      const gc = groupCall;
      if (gc) {
        clearTimeout(gc.ringTimeout);
        clearInterval(gc.heartbeat);
        if (gc.unsubDoc) gc.unsubDoc();
        if (gc.unsubSignals) gc.unsubSignals();
        [...gc.peers.keys()].forEach(removeGroupPeer);
      }
      groupCall = null;
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
      const grid = document.getElementById('group-call-grid');
      if (grid) { grid.innerHTML = ''; grid.classList.add('hidden'); }
      document.getElementById('local-video').srcObject = null;
      document.getElementById('local-video').classList.add('hidden');
      const avWrap = document.getElementById('call-avatar-wrap'); if (avWrap) avWrap.classList.remove('hidden');
      const overlay = document.getElementById('call-overlay');
      overlay.classList.add('hidden'); overlay.classList.remove('flex');
      ['call-mute-btn', 'call-video-toggle-btn', 'call-accept-btn'].forEach(id => {
        const el = document.getElementById(id); el.classList.add('hidden'); el.classList.remove('flex');
      });
      document.getElementById('call-mute-btn').innerHTML = '<i class="fas fa-microphone"></i>';
      document.getElementById('call-video-toggle-btn').innerHTML = '<i class="fas fa-video"></i>';
      currentCallId = null; isMuted = false; isCameraOff = false;
    }

    // ==========================================================
    // APP LOCK (PIN + WebAuthn biometric)
    //
    // This is a DEVICE-level lock, stored in localStorage — not synced to
    // Firestore, since a PIN protecting "this phone" shouldn't carry over
    // to a different device automatically. The PIN itself is never stored
    // in plaintext; it's hashed with SHA-256 via the browser's built-in
    // Web Crypto API before being saved.
    // ==========================================================

    async function sha256Hex(text) {
      const data = new TextEncoder().encode(text);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function appLockEnabled() {
      return localStorage.getItem('privatechat-applock-enabled') === 'true';
    }
    function appLockHasPin() {
      return !!localStorage.getItem('privatechat-applock-pinhash');
    }
    function appLockHasBiometric() {
      return !!localStorage.getItem('privatechat-applock-webauthn-id');
    }

    window.toggleAppLockSetting = function () {
      if (!appLockEnabled()) {
        if (!appLockHasPin()) {
          // Turning it on for the first time — must set a PIN before it can be enabled.
          openSetPinModal();
          return;
        }
        localStorage.setItem('privatechat-applock-enabled', 'true');
      } else {
        localStorage.setItem('privatechat-applock-enabled', 'false');
      }
      syncAppLockSettingsUI();
    };

    function syncAppLockSettingsUI() {
      const enabled = appLockEnabled();
      const toggle = document.getElementById('app-lock-toggle');
      const knob = document.getElementById('app-lock-knob');
      const setupArea = document.getElementById('app-lock-setup-area');
      toggle.classList.toggle('bg-blue-600', enabled);
      toggle.classList.toggle('bg-gray-700', !enabled);
      knob.style.transform = enabled ? 'translateX(20px)' : 'translateX(0)';
      setupArea.classList.toggle('hidden', !enabled);

      document.getElementById('pin-setup-label').textContent = appLockHasPin() ? 'Change PIN' : 'Set PIN';

      const bioBtn = document.getElementById('biometric-setup-btn');
      const bioLabel = document.getElementById('biometric-setup-label');
      const webAuthnSupported = !!(window.PublicKeyCredential);
      if (!webAuthnSupported) {
        bioBtn.classList.add('hidden');
      } else {
        bioBtn.classList.remove('hidden');
        bioLabel.textContent = appLockHasBiometric() ? 'Face ID / Fingerprint enabled ✓' : 'Enable Face ID / Fingerprint';
      }
    }

    // ---------- Set/change PIN modal ----------
    window.openSetPinModal = function () {
      pinSetupStage = 'first';
      pinSetupBuffer = '';
      pinSetupFirstEntry = '';
      document.getElementById('set-pin-title').textContent = 'Set a 4-digit PIN';
      document.getElementById('set-pin-error').classList.add('hidden');
      updateSetPinDots();
      document.getElementById('set-pin-modal').classList.remove('hidden');
    };

    window.closeSetPinModal = function () {
      document.getElementById('set-pin-modal').classList.add('hidden');
      // If they cancel out without ever setting a PIN, app lock stays off.
      if (!appLockHasPin()) {
        localStorage.setItem('privatechat-applock-enabled', 'false');
      }
      syncAppLockSettingsUI();
    };

    window.setPinPadPress = function (digit) {
      if (pinSetupBuffer.length >= 4) return;
      pinSetupBuffer += digit;
      updateSetPinDots();
      if (pinSetupBuffer.length === 4) {
        setTimeout(handleSetPinComplete, 150);
      }
    };

    window.setPinPadBackspace = function () {
      pinSetupBuffer = pinSetupBuffer.slice(0, -1);
      updateSetPinDots();
    };

    function updateSetPinDots() {
      for (let i = 0; i < 4; i++) {
        const dot = document.getElementById(`set-pin-dot-${i}`);
        dot.classList.toggle('pin-dot-filled', i < pinSetupBuffer.length);
      }
    }

    async function handleSetPinComplete() {
      const errEl = document.getElementById('set-pin-error');
      if (pinSetupStage === 'first') {
        pinSetupFirstEntry = pinSetupBuffer;
        pinSetupBuffer = '';
        pinSetupStage = 'confirm';
        document.getElementById('set-pin-title').textContent = 'Confirm your PIN';
        updateSetPinDots();
        return;
      }

      // Confirm stage
      if (pinSetupBuffer !== pinSetupFirstEntry) {
        errEl.textContent = "PINs didn't match — try again.";
        errEl.classList.remove('hidden');
        pinSetupStage = 'first';
        pinSetupBuffer = '';
        pinSetupFirstEntry = '';
        document.getElementById('set-pin-title').textContent = 'Set a 4-digit PIN';
        updateSetPinDots();
        return;
      }

      const hash = await sha256Hex(pinSetupBuffer);
      localStorage.setItem('privatechat-applock-pinhash', hash);
      localStorage.setItem('privatechat-applock-enabled', 'true');
      document.getElementById('set-pin-modal').classList.add('hidden');
      syncAppLockSettingsUI();
    }

    // ---------- Biometric registration (WebAuthn) ----------
    window.registerBiometric = async function () {
      if (!window.PublicKeyCredential) {
        alert("Your browser doesn't support Face ID / Fingerprint unlock.");
        return;
      }
      try {
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const userIdBytes = new TextEncoder().encode(currentUserData.uid);
        const credential = await navigator.credentials.create({
          publicKey: {
            challenge,
            rp: { name: 'PrivateChat' },
            user: {
              id: userIdBytes,
              name: currentUserData.email || currentUserData.displayName,
              displayName: currentUserData.displayName
            },
            pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
            authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
            timeout: 60000
          }
        });
        if (credential) {
          // Store the credential ID locally so we can request it again at unlock time.
          const idB64 = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
          localStorage.setItem('privatechat-applock-webauthn-id', idB64);
          syncAppLockSettingsUI();
        }
      } catch (err) {
        if (err.name !== 'NotAllowedError') { // user cancelled — not an error worth alerting
          alert('Could not set up Face ID / Fingerprint on this device.');
        }
      }
    };

    // ---------- The actual lock screen shown on app open/foreground ----------
    function showAppLockScreen() {
      isAppLocked = true;
      enteredPin = '';
      updateUnlockDots();
      document.getElementById('applock-error').classList.add('hidden');
      const bioBtn = document.getElementById('applock-biometric-btn');
      if (appLockHasBiometric()) {
        bioBtn.classList.remove('hidden');
        bioBtn.classList.add('flex');
      } else {
        bioBtn.classList.add('hidden');
      }
      document.getElementById('app-lock-screen').classList.remove('hidden');
      document.getElementById('app-lock-screen').classList.add('flex');

      // Offer biometric immediately so it doesn't require an extra tap.
      if (appLockHasBiometric()) {
        setTimeout(() => tryBiometricUnlock(), 300);
      }
    }

    function hideAppLockScreen() {
      isAppLocked = false;
      document.getElementById('app-lock-screen').classList.add('hidden');
      document.getElementById('app-lock-screen').classList.remove('flex');
    }

    window.pinPadPress = function (digit) {
      if (enteredPin.length >= 4) return;
      enteredPin += digit;
      updateUnlockDots();
      if (enteredPin.length === 4) {
        setTimeout(checkUnlockPin, 150);
      }
    };

    window.pinPadBackspace = function () {
      enteredPin = enteredPin.slice(0, -1);
      updateUnlockDots();
    };

    function updateUnlockDots() {
      for (let i = 0; i < 4; i++) {
        const dot = document.getElementById(`pin-dot-${i}`);
        dot.classList.remove('pin-dot-error');
        dot.classList.toggle('pin-dot-filled', i < enteredPin.length);
      }
    }

    async function checkUnlockPin() {
      const storedHash = localStorage.getItem('privatechat-applock-pinhash');
      const enteredHash = await sha256Hex(enteredPin);
      if (enteredHash === storedHash) {
        hideAppLockScreen();
      } else {
        const errEl = document.getElementById('applock-error');
        errEl.textContent = 'Incorrect PIN — try again.';
        errEl.classList.remove('hidden');
        for (let i = 0; i < 4; i++) document.getElementById(`pin-dot-${i}`).classList.add('pin-dot-error');
        enteredPin = '';
        setTimeout(updateUnlockDots, 400);
      }
    }

    window.tryBiometricUnlock = async function () {
      const idB64 = localStorage.getItem('privatechat-applock-webauthn-id');
      if (!idB64 || !window.PublicKeyCredential) return;
      try {
        const rawId = Uint8Array.from(atob(idB64), c => c.charCodeAt(0));
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge,
            allowCredentials: [{ id: rawId, type: 'public-key' }],
            userVerification: 'required',
            timeout: 60000
          }
        });
        if (assertion) hideAppLockScreen();
      } catch (err) {
        // User cancelled or it failed — just let them fall back to PIN, no alert needed.
      }
    };

    // Trigger the lock whenever the app is backgrounded/closed and comes back.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (appLockEnabled() && currentUserData) {
          appLockPending = true;
        }
      } else if (document.visibilityState === 'visible') {
        if (appLockPending && appLockEnabled() && currentUserData) {
          showAppLockScreen();
        }
      }
    });

    // ---------- PWA: register service worker (enables "Add to Home Screen" + offline shell) ----------
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
          console.warn('Service worker registration failed:', err);
        });
      });
    }
