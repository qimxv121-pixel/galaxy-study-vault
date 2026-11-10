
"use strict";

/* =========================================
   GALAXY STUDY VAULT
   Google Drive Personal Storage
========================================= */

const CONFIG = {
    CLIENT_ID: "149082490689-7ac7frv2tsju2lmaen8uu335beklq8kp.apps.googleusercontent.com",

    APP_FOLDER: "GALAXY_STUDY_VAULT",

    DRIVE_SCOPE: "https://www.googleapis.com/auth/drive.file",

    API: "https://www.googleapis.com/drive/v3/files",

    UPLOAD_API: "https://www.googleapis.com/upload/drive/v3/files",

    MAX_FILE_SIZE: 100 * 1024 * 1024
};


/* =========================================
   APP STATE
========================================= */

const state = {
    user: null,
    accessToken: null,
    tokenClient: null,
    rootFolder: null,
    subjects: [],
    files: [],
    currentSubject: null,
    selectedFile: null,
    currentView: "home",
    search: "",
    busy: false
};

const $ = id => document.getElementById(id);

const escapeHTML = value => String(value ?? "").replace(
    /[&<>"']/g,
    char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]
);


/* =========================================
   STARTUP
========================================= */

document.addEventListener("DOMContentLoaded", () => {

    initStars();
    bindEvents();

    waitForGoogleIdentity();

});


function waitForGoogleIdentity() {

    let attempts = 0;

    const timer = setInterval(() => {

        attempts++;

        if (window.google?.accounts?.id) {

            clearInterval(timer);

            initializeGoogleLogin();

            return;
        }

        if (attempts > 40) {

            clearInterval(timer);

            $("loginError").textContent =
                "Google Login gagal dimuat. Periksa koneksi internet.";

        }

    }, 250);

}


/* =========================================
   GOOGLE LOGIN
========================================= */

function initializeGoogleLogin() {

    if (!CONFIG.CLIENT_ID ||
        CONFIG.CLIENT_ID.includes("ISI_CLIENT_ID")) {

        $("loginError").textContent =
            "Masukkan Google OAuth Client ID terlebih dahulu di script.js.";

        $("googleButton").innerHTML =
            '<p class="error-message">Google Client ID belum dikonfigurasi.</p>';

        return;
    }

    google.accounts.id.initialize({

        client_id: CONFIG.CLIENT_ID,

        callback: handleGoogleLogin,

        auto_select: false

    });

    $("googleButton").innerHTML = "";

    google.accounts.id.renderButton(
        $("googleButton"),
        {
            theme: "filled_black",
            size: "large",
            shape: "pill",
            text: "continue_with",
            width: 280
        }
    );

}


function decodeGoogleToken(token) {

    const parts = token.split(".");

    if (parts.length !== 3) {
        throw new Error("Token Google tidak valid.");
    }

    const base64 = parts[1]
        .replace(/-/g, "+")
        .replace(/_/g, "/");

    const decoded = decodeURIComponent(
        atob(base64)
            .split("")
            .map(c =>
                "%" + c.charCodeAt(0)
                    .toString(16)
                    .padStart(2, "0")
            )
            .join("")
    );

    return JSON.parse(decoded);
}


function handleGoogleLogin(response) {

    try {

        if (!response.credential) {
            throw new Error("Google tidak memberikan kredensial.");
        }

        const account = decodeGoogleToken(response.credential);

        if (!account.sub || !account.email) {
            throw new Error("Informasi akun Google tidak lengkap.");
        }

        state.user = {
            id: account.sub,
            email: account.email,
            name: account.name || account.email,
            picture: account.picture || ""
        };

        /*
          Token ID digunakan untuk menampilkan identitas
          hasil Google Sign-In pada antarmuka.

          Akses Google Drive tetap memerlukan OAuth access token.
        */

        state.tokenClient = google.accounts.oauth2.initTokenClient({

            client_id: CONFIG.CLIENT_ID,

            scope: CONFIG.DRIVE_SCOPE,

            callback: async tokenResponse => {

                if (tokenResponse.error) {

                    showToast(
                        "Izin Google Drive gagal: " +
                        tokenResponse.error
                    );

                    return;
                }

                state.accessToken = tokenResponse.access_token;

                await enterApplication();

            }

        });

        state.tokenClient.requestAccessToken({
            prompt: "consent"
        });

    } catch (error) {

        console.error(error);

        $("loginError").textContent = error.message;

    }

}


/* =========================================
   AUTHORIZATION
========================================= */

function requireLogin() {

    if (!state.accessToken) {

        throw new Error(
            "Sesi Google Drive tidak tersedia. Silakan login ulang."
        );

    }

}


async function driveRequest(url, options = {}) {

    requireLogin();

    const headers = new Headers(options.headers || {});

    headers.set(
        "Authorization",
        "Bearer " + state.accessToken
    );

    const response = await fetch(url, {
        ...options,
        headers
    });

    if (response.status === 401) {

        state.accessToken = null;

        throw new Error(
            "Sesi Google Drive telah berakhir. Login ulang diperlukan."
        );
    }

    if (!response.ok) {

        let detail = "";

        try {

            const result = await response.json();

            detail = result.error?.message || "";

        } catch (_) {}

        throw new Error(
            `Google Drive Error ${response.status}: ` +
            (detail || response.statusText)
        );
    }

    if (response.status === 204) return null;

    return response.json();

}


/* =========================================
   ENTER APPLICATION
========================================= */

async function enterApplication() {

    try {

        showToast("Menghubungkan ke Google Drive...");

        $("loginScreen").classList.add("hidden");

        $("appScreen").classList.remove("hidden");

        $("userName").textContent = state.user.name;

        $("userEmail").textContent = state.user.email;

        $("userPhoto").src =
            state.user.picture ||
            "https://www.gravatar.com/avatar/?d=mp";

        await initializeDriveStorage();

        await refreshData();

        showView("home");

        showToast("Selamat datang di Galaxy Study Vault!");

    } catch (error) {

        console.error(error);

        showToast(error.message);

        $("appScreen").classList.add("hidden");

        $("loginScreen").classList.remove("hidden");

    }

}


/* =========================================
   DRIVE API HELPERS
========================================= */

function escapeDriveQuery(value) {

    return String(value)
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'");

}


async function listDriveFiles(query) {

    const params = new URLSearchParams({

        q: query + " and trashed = false",

        pageSize: "1000",

        orderBy: "name",

        fields:
            "files(id,name,mimeType,size,modifiedTime,webViewLink,parents)"

    });

    const result = await driveRequest(
        CONFIG.API + "?" + params.toString()
    );

    return result.files || [];

}


async function createDriveFolder(name, parentId = null) {

    const metadata = {

        name: name,

        mimeType: "application/vnd.google-apps.folder"

    };

    if (parentId) {
        metadata.parents = [parentId];
    }

    return driveRequest(
        CONFIG.API + "?fields=id,name,mimeType",
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify(metadata)
        }
    );

}


/* =========================================
   PERSONAL DRIVE ROOT
========================================= */

function getLocalKey(name) {

    return `gsv_${state.user.id}_${name}`;

}


async function initializeDriveStorage() {

    const cacheKey = getLocalKey("rootFolder");

    let rootId = localStorage.getItem(cacheKey);

    if (rootId) {

        try {

            const params = new URLSearchParams({

                fields: "id,name,mimeType,trashed"

            });

            const folder = await driveRequest(
                CONFIG.API + "/" +
                encodeURIComponent(rootId) +
                "?" + params
            );

            if (
                folder.mimeType !==
                "application/vnd.google-apps.folder" ||
                folder.trashed
            ) {
                rootId = null;
            }

        } catch (error) {

            console.warn("Folder cache tidak ditemukan:", error);

            rootId = null;

        }

    }

    if (!rootId) {

        /*
          Cari folder aplikasi yang pernah dibuat.
          Drive API hanya mengakses file yang tersedia
          dalam cakupan izin aplikasi.
        */

        const folders = await listDriveFiles(
            "name = '" +
            escapeDriveQuery(CONFIG.APP_FOLDER) +
            "' and mimeType = 'application/vnd.google-apps.folder'"
        );

        if (folders.length > 0) {

            rootId = folders[0].id;

        } else {

            const folder = await createDriveFolder(
                CONFIG.APP_FOLDER
            );

            rootId = folder.id;

        }

        localStorage.setItem(cacheKey, rootId);

    }

    state.rootFolder = rootId;

}


/* =========================================
   SUBJECT MANAGEMENT
========================================= */

async function createSubject(name) {

    name = name.trim();

    if (!name) {
        throw new Error("Nama mata kuliah wajib diisi.");
    }

    if (state.subjects.some(
        subject => subject.name.toLowerCase() === name.toLowerCase()
    )) {
        throw new Error("Mata kuliah tersebut sudah ada.");
    }

    const folder = await createDriveFolder(
        name,
        state.rootFolder
    );

    await refreshData();

    return folder;

}


async function renameSubject(id, oldName) {

    const newName = prompt(
        "Masukkan nama mata kuliah baru:",
        oldName
    );

    if (newName === null) return;

    const name = newName.trim();

    if (!name || name === oldName) return;

    const result = await driveRequest(
        CONFIG.API + "/" + encodeURIComponent(id),
        {
            method: "PATCH",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                name: name
            })
        }
    );

    await refreshData();

    showToast("Nama mata kuliah diperbarui.");

}


async function deleteSubject(id, name) {

    const confirmDelete = confirm(
        `Hapus folder "${name}" beserta seluruh isinya? ` +
        "Penghapusan ini memindahkan folder ke sampah Google Drive."
    );

    if (!confirmDelete) return;

    await driveRequest(
        CONFIG.API + "/" + encodeURIComponent(id),
        {
            method: "DELETE"
        }
    );

    if (state.currentSubject?.id === id) {
        state.currentSubject = null;
    }

    await refreshData();

    showToast("Folder dipindahkan ke sampah.");

}


/* =========================================
   FILE UPLOAD
========================================= */

async function uploadFile(file, folderId) {

    if (!folderId) {
        throw new Error("Folder mata kuliah belum dipilih.");
    }

    if (file.size > CONFIG.MAX_FILE_SIZE) {

        throw new Error(
            `${file.name} melebihi batas upload aplikasi 100 MB.`
        );

    }

    const metadata = {

        name: file.name,

        mimeType: file.type || "application/octet-stream",

        parents: [folderId]

    };

    const boundary =
        "galaxy_boundary_" +
        crypto.randomUUID().replace(/-/g, "");

    const body = new Blob([

        `--${boundary}\r\n`,

        "Content-Type: application/json; charset=UTF-8\r\n\r\n",

        JSON.stringify(metadata),

        `\r\n--${boundary}\r\n`,

        `Content-Type: ${
            file.type || "application/octet-stream"
        }\r\n\r\n`,

        file,

        `\r\n--${boundary}--`

    ]);

    const params = new URLSearchParams({
        uploadType: "multipart",
        fields:
            "id,name,mimeType,size,modifiedTime,webViewLink,parents"
    });

    const result = await driveRequest(
        CONFIG.UPLOAD_API + "?" + params.toString(),
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "multipart/related; boundary=" + boundary
            },

            body: body
        }
    );

    return result;

}


async function uploadSelectedFiles() {

    const folderId = $("uploadSubject").value;

    const files = Array.from(
        $("fileInput").files || []
    );

    if (!folderId) {

        showToast("Pilih mata kuliah terlebih dahulu.");

        return;
    }

    if (!files.length) {

        showToast("Pilih file yang ingin diupload.");

        return;
    }

    const button = $("confirmUploadBtn");

    button.disabled = true;

    let success = 0;

    let errors = [];

    try {

        for (let i = 0; i < files.length; i++) {

            const file = files[i];

            $("uploadStatus").textContent =
                `Mengunggah ${i + 1}/${files.length}: ${file.name}`;

            try {

                await uploadFile(file, folderId);

                success++;

            } catch (error) {

                errors.push(file.name + ": " + error.message);

            }

        }

        await refreshData();

        $("uploadStatus").textContent =
            `${success} file berhasil diunggah.`;

        $("fileInput").value = "";

        $("selectedFiles").textContent =
            "Belum ada file dipilih.";

        if (errors.length) {

            showToast(
                `${success} berhasil, ${errors.length} gagal.`
            );

            console.error(errors);

        } else {

            showToast(
                `${success} file berhasil disimpan di Google Drive!`
            );

            setTimeout(() => {

                closeModal("uploadModal");

                $("uploadStatus").textContent = "";

            }, 1200);

        }

    } finally {

        button.disabled = false;

    }

}


/* =========================================
   DOWNLOAD FILE
========================================= */

async function downloadFile(file) {

    const response = await fetch(
        CONFIG.API + "/" +
        encodeURIComponent(file.id) +
        "?alt=media",
        {
            headers: {
                Authorization: "Bearer " + state.accessToken
            }
        }
    );

    if (!response.ok) {

        throw new Error(
            "Gagal mengunduh file: " + response.status
        );

    }

    const blob = await response.blob();

    const url = URL.createObjectURL(blob);

    const anchor = document.createElement("a");

    anchor.href = url;

    anchor.download = file.name;

    document.body.appendChild(anchor);

    anchor.click();

    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(url), 60000);

    showToast("Download dimulai.");

}


/* =========================================
   DELETE FILE
========================================= */

async function deleteFile(file) {

    const yes = confirm(
        `Hapus file "${file.name}" dari Google Drive?`
    );

    if (!yes) return;

    await driveRequest(
        CONFIG.API + "/" + encodeURIComponent(file.id),
        {
            method: "DELETE"
        }
    );

    closeModal("previewModal");

    state.selectedFile = null;

    await refreshData();

    showToast("File dipindahkan ke sampah Google Drive.");

}


/* =========================================
   LOAD DATA
========================================= */

async function refreshData() {

    const folders = await listDriveFiles(
        "'" + state.rootFolder + "' in parents and " +
        "mimeType = 'application/vnd.google-apps.folder'"
    );

    state.subjects = folders;

    const files = await listDriveFiles(
        "'" + state.rootFolder + "' in parents and " +
        "mimeType != 'application/vnd.google-apps.folder'"
    );

    const allFiles = [];

    for (const folder of folders) {

        const children = await listDriveFiles(
            "'" + folder.id + "' in parents"
        );

        children.forEach(file => {

            allFiles.push({

                ...file,

                subjectName: folder.name,

                subjectId: folder.id

            });

        });

    }

    state.files = allFiles.sort((a, b) => {

        return new Date(b.modifiedTime || 0) -
               new Date(a.modifiedTime || 0);

    });

    renderApplication();

    saveLocalCache();

}


function saveLocalCache() {

    if (!state.user) return;

    const cache = {

        updatedAt: Date.now(),

        subjects: state.subjects.map(s => ({
            id: s.id,
            name: s.name
        })),

        files: state.files.map(f => ({
            id: f.id,
            name: f.name,
            subjectId: f.subjectId,
            subjectName: f.subjectName,
            size: f.size,
            modifiedTime: f.modifiedTime
        }))

    };

    /*
      Cache hanya untuk mempercepat tampilan.
      Data resmi tetap berada di Google Drive.
    */

    try {

        localStorage.setItem(
            getLocalKey("cache"),
            JSON.stringify(cache)
        );

    } catch (error) {

        console.warn("Cache lokal tidak dapat disimpan:", error);

    }

}


/* =========================================
   RENDER
========================================= */

function formatSize(bytes) {

    const value = Number(bytes || 0);

    if (value < 1024) return value + " B";

    if (value < 1024 ** 2) {
        return (value / 1024).toFixed(1) + " KB";
    }

    if (value < 1024 ** 3) {
        return (value / 1024 ** 2).toFixed(2) + " MB";
    }

    return (value / 1024 ** 3).toFixed(2) + " GB";

}


function formatDate(value) {

    if (!value) return "-";

    return new Date(value).toLocaleDateString(
        "id-ID",
        {
            day: "numeric",
            month: "short",
            year: "numeric"
        }
    );

}


function getFileIcon(file) {

    const name = file.name.toLowerCase();

    if (name.endsWith(".pdf")) return "📕";

    if (/\.(doc|docx)$/.test(name)) return "📘";

    if (/\.(xls|xlsx|csv)$/.test(name)) return "📗";

    if (/\.(ppt|pptx)$/.test(name)) return "📙";

    if (/\.(jpg|jpeg|png|gif|webp|svg)$/.test(name)) {
        return "🖼️";
    }

    if (/\.(zip|rar|7z)$/.test(name)) return "📦";

    if (/\.(js|html|css|py|java|cpp|gs)$/.test(name)) {
        return "💻";
    }

    return "📄";

}


function renderApplication() {

    $("subjectCount").textContent = state.subjects.length;

    $("fileCount").textContent = state.files.length;

    const totalSize = state.files.reduce(
        (total, file) => total + Number(file.size || 0),
        0
    );

    $("storageUsed").textContent = formatSize(totalSize);

    renderSubjects();

    renderRecentFiles();

    renderSubjectNavigation();

    renderUploadOptions();

    renderCurrentView();

}


function renderSubjects() {

    const html = state.subjects.map(subject => `

        <article class="subject-card"
                 data-open-subject="${escapeHTML(subject.id)}">

            <button class="subject-menu"
                    data-subject-menu="${escapeHTML(subject.id)}"
                    title="Kelola folder">⋮</button>

            <div class="subject-icon">📚</div>

            <h3>${escapeHTML(subject.name)}</h3>

            <p>
                ${
                    state.files.filter(
                        f => f.subjectId === subject.id
                    ).length
                } file tersimpan
            </p>

        </article>

    `).join("");

    const empty = `
        <div class="empty-state">
            <div>🪐</div>
            <h3>Belum ada mata kuliah</h3>
            <p>Buat folder pertama untuk memulai.</p>
        </div>
    `;

    $("subjectGrid").innerHTML = html || empty;

    $("allSubjectGrid").innerHTML = html || empty;

}


function renderSubjectNavigation() {

    $("subjectNavigation").innerHTML = state.subjects.length

        ? state.subjects.map(subject => `

            <button class="subject-nav-item"
                    data-open-subject="${escapeHTML(subject.id)}">
                🪐 ${escapeHTML(subject.name)}
            </button>

        `).join("")

        : '<p class="muted small-text">Belum ada mata kuliah</p>';

}


function renderUploadOptions() {

    const select = $("uploadSubject");

    const oldValue = select.value;

    select.innerHTML =
        '<option value="">Pilih mata kuliah</option>' +

        state.subjects.map(subject => `

            <option value="${escapeHTML(subject.id)}">
                ${escapeHTML(subject.name)}
            </option>

        `).join("");

    if (state.subjects.some(s => s.id === oldValue)) {
        select.value = oldValue;
    }

    if (state.currentSubject) {
        select.value = state.currentSubject.id;
    }

}


function renderFileRows(files) {

    if (!files.length) {

        return `
            <div class="empty-state">
                <div>✨</div>
                <h3>Belum ada file</h3>
                <p>Upload tugas kuliahmu untuk memulai.</p>
            </div>
        `;

    }

    return files.map(file => `

        <div class="file-row"
             data-open-file="${escapeHTML(file.id)}">

            <div class="file-icon">
                ${getFileIcon(file)}
            </div>

            <div class="file-details">

                <strong>${escapeHTML(file.name)}</strong>

                <small>
                    ${escapeHTML(file.subjectName || "File")}
                    ·
                    ${formatDate(file.modifiedTime)}
                </small>

            </div>

            <span class="file-size">
                ${formatSize(file.size)}
            </span>

            <span class="file-more">›</span>

        </div>

    `).join("");

}


function renderRecentFiles() {

    const files = state.files.slice(0, 5);

    $("recentFiles").innerHTML =
        renderFileRows(files);

    $("recentFullList").innerHTML =
        renderFileRows(state.files);

}


function renderCurrentView() {

    const query = state.search.toLowerCase();

    const views = [
        "home",
        "subjects",
        "files",
        "recent"
    ];

    views.forEach(view => {

        const element = $(view + "View");

        if (element) {

            element.classList.toggle(
                "hidden",
                view !== state.currentView
            );

        }

    });

    const titles = {

        home: [
            "Welcome to Your Universe",
            "Semua tugas kuliahmu tersimpan dalam satu tempat."
        ],

        subjects: [
            "My Academic Universe",
            "Kelola folder mata kuliahmu."
        ],

        files: [
            "All Your Files",
            "Seluruh file dari Google Drive akunmu."
        ],

        recent: [
            "Recently Uploaded",
            "Lihat tugas yang terakhir kamu simpan."
        ]

    };

    $("pageTitle").textContent = titles[state.currentView][0];

    $("pageSubtitle").textContent = titles[state.currentView][1];

    const filteredFiles = state.files.filter(file => {

        return (
            file.name.toLowerCase().includes(query) ||
            (file.subjectName || "").toLowerCase().includes(query)
        );

    });

    if (state.currentView === "files") {

        $("fileList").innerHTML =
            renderFileRows(filteredFiles);

    }

    if (state.currentView === "recent") {

        $("recentFullList").innerHTML =
            renderFileRows(filteredFiles.slice(0, 100));

    }

    if (state.currentView === "subjects") {

        const filteredSubjects = state.subjects.filter(subject => {

            return subject.name.toLowerCase().includes(query);

        });

        $("allSubjectGrid").innerHTML =
            renderSubjectCards(filteredSubjects);

    }

    if (state.currentView === "home" && query) {

        $("recentFiles").innerHTML =
            renderFileRows(filteredFiles.slice(0, 5));

    }

}


function renderSubjectCards(subjects) {

    if (!subjects.length) {

        return `
            <div class="empty-state">
                <div>🪐</div>
                <h3>Tidak ditemukan</h3>
            </div>
        `;

    }

    return subjects.map(subject => `

        <article class="subject-card"
                 data-open-subject="${escapeHTML(subject.id)}">

            <button class="subject-menu"
                    data-subject-menu="${escapeHTML(subject.id)}">
                ⋮
            </button>

            <div class="subject-icon">📚</div>

            <h3>${escapeHTML(subject.name)}</h3>

            <p>
                ${
                    state.files.filter(
                        f => f.subjectId === subject.id
                    ).length
                } file tersimpan
            </p>

        </article>

    `).join("");

}


/* =========================================
   NAVIGATION
========================================= */

function showView(view) {

    state.currentView = view;

    state.currentSubject = null;

    document.querySelectorAll(".nav-item").forEach(button => {

        button.classList.toggle(
            "active",
            button.dataset.view === view
        );

    });

    renderCurrentView();

}


function openSubject(id) {

    const subject = state.subjects.find(s => s.id === id);

    if (!subject) return;

    state.currentSubject = subject;

    state.currentView = "files";

    document.querySelectorAll(".nav-item").forEach(button => {
        button.classList.remove("active");
    });

    $("fileViewTitle").textContent = subject.name;

    $("fileViewSubtitle").textContent =
        "Semua tugas dalam folder mata kuliah ini.";

    const files = state.files.filter(
        f => f.subjectId === subject.id
    );

    $("fileList").innerHTML =
        renderFileRows(files);

    $("pageTitle").textContent = subject.name;

    $("pageSubtitle").textContent =
        "Folder khusus mata kuliah.";

    $("homeView").classList.add("hidden");

    $("subjectsView").classList.add("hidden");

    $("recentView").classList.add("hidden");

    $("filesView").classList.remove("hidden");

}


/* =========================================
   FILE DETAILS
========================================= */

function openFile(id) {

    const file = state.files.find(f => f.id === id);

    if (!file) return;

    state.selectedFile = file;

    $("previewName").textContent = file.name;

    $("previewInfo").textContent =
        `${file.subjectName} • ${formatSize(file.size)} • ` +
        formatDate(file.modifiedTime);

    openModal("previewModal");

}


function openDriveFile() {

    if (!state.selectedFile) return;

    const file = state.selectedFile;

    const url = file.webViewLink ||
        "https://drive.google.com/file/d/" +
        encodeURIComponent(file.id) +
        "/view";

    window.open(url, "_blank", "noopener,noreferrer");

}


/* =========================================
   MODAL
========================================= */

function openModal(id) {

    $(id).classList.remove("hidden");

}


function closeModal(id) {

    $(id).classList.add("hidden");

}


/* =========================================
   TOAST
========================================= */

let toastTimer;

function showToast(message) {

    const toast = $("toast");

    toast.textContent = message;

    toast.classList.add("show");

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {

        toast.classList.remove("show");

    }, 3200);

}


/* =========================================
   EVENTS
========================================= */

function bindEvents() {

    $("logoutBtn").addEventListener(
        "click",
        logout
    );

    $("addSubjectBtn").addEventListener(
        "click",
        () => openModal("subjectModal")
    );

    $("sidebarAddSubject").addEventListener(
        "click",
        () => openModal("subjectModal")
    );

    $("saveSubjectBtn").addEventListener(
        "click",
        async () => {

            try {

                const name = $("subjectName").value;

                await createSubject(name);

                $("subjectName").value = "";

                closeModal("subjectModal");

                showToast("Folder mata kuliah berhasil dibuat.");

            } catch (error) {

                showToast(error.message);

            }

        }
    );

    $("uploadTopBtn").addEventListener(
        "click",
        () => {

            renderUploadOptions();

            openModal("uploadModal");

        }
    );

    $("confirmUploadBtn").addEventListener(
        "click",
        uploadSelectedFiles
    );

    $("fileInput").addEventListener(
        "change",
        () => {

            const files = Array.from(
                $("fileInput").files || []
            );

            $("selectedFiles").textContent = files.length

                ? files.map(file =>
                    `${file.name} (${formatSize(file.size)})`
                  ).join("\n")

                : "Belum ada file dipilih.";

        }
    );

    $("downloadFileBtn").addEventListener(
        "click",
        async () => {

            try {

                if (state.selectedFile) {

                    await downloadFile(state.selectedFile);

                }

            } catch (error) {

                showToast(error.message);

            }

        }
    );

    $("openDriveBtn").addEventListener(
        "click",
        openDriveFile
    );

    $("deleteFileBtn").addEventListener(
        "click",
        async () => {

            try {

                if (state.selectedFile) {

                    await deleteFile(state.selectedFile);

                }

            } catch (error) {

                showToast(error.message);

            }

        }
    );

    $("searchInput").addEventListener(
        "input",
        event => {

            state.search = event.target.value;

            renderCurrentView();

        }
    );

    document.querySelectorAll(".nav-item").forEach(button => {

        button.addEventListener("click", () => {

            showView(button.dataset.view);

        });

    });

    document.querySelectorAll("[data-go]").forEach(button => {

        button.addEventListener("click", () => {

            showView(button.dataset.go);

        });

    });

    document.querySelectorAll("[data-close]").forEach(button => {

        button.addEventListener("click", () => {

            closeModal(button.dataset.close);

        });

    });

    document.addEventListener("click", async event => {

        const subjectMenu =
            event.target.closest("[data-subject-menu]");

        if (subjectMenu) {

            event.stopPropagation();

            const id = subjectMenu.dataset.subjectMenu;

            const subject = state.subjects.find(s => s.id === id);

            if (!subject) return;

            const action = prompt(
                `Kelola ${subject.name}\n` +
                "1 = Ubah nama\n" +
                "2 = Hapus folder\n" +
                "Kosongkan = Batal"
            );

            try {

                if (action === "1") {

                    await renameSubject(id, subject.name);

                } else if (action === "2") {

                    await deleteSubject(id, subject.name);

                }

            } catch (error) {

                showToast(error.message);

            }

            return;

        }

        const subjectCard =
            event.target.closest("[data-open-subject]");

        if (subjectCard) {

            if (event.target.closest("[data-subject-menu]")) return;

            openSubject(subjectCard.dataset.openSubject);

            return;

        }

        const fileRow =
            event.target.closest("[data-open-file]");

        if (fileRow) {

            openFile(fileRow.dataset.openFile);

        }

    });

    /*
      Tutup modal jika pengguna menekan area luar kartu.
    */

    document.querySelectorAll(".modal").forEach(modal => {

        modal.addEventListener("click", event => {

            if (event.target === modal) {
                modal.classList.add("hidden");
            }

        });

    });

}


/* =========================================
   LOGOUT
========================================= */

function logout() {

    if (!confirm("Keluar dari Galaxy Study Vault?")) return;

    state.accessToken = null;

    state.user = null;

    state.rootFolder = null;

    state.subjects = [];

    state.files = [];

    state.currentSubject = null;

    state.selectedFile = null;

    /*
      Cache per pengguna tidak dihapus.
      Tidak ada file Google Drive yang dihapus.
    */

    try {

        google.accounts.id.disableAutoSelect();

    } catch (_) {}

    $("appScreen").classList.add("hidden");

    $("loginScreen").classList.remove("hidden");

    $("userPhoto").src = "";

    $("loginError").textContent = "";

    showToast("Kamu telah keluar.");

}


/* =========================================
   GALAXY STAR ANIMATION
========================================= */

function initStars() {

    const canvas = $("stars");

    const ctx = canvas.getContext("2d");

    let stars = [];

    function resize() {

        const ratio = Math.min(
            window.devicePixelRatio || 1,
            2
        );

        canvas.width = innerWidth * ratio;

        canvas.height = innerHeight * ratio;

        canvas.style.width = innerWidth + "px";

        canvas.style.height = innerHeight + "px";

        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

        const count = Math.min(
            180,
            Math.floor(innerWidth / 5)
        );

        stars = Array.from({ length: count }, () => ({

            x: Math.random() * innerWidth,

            y: Math.random() * innerHeight,

            radius: Math.random() * 1.5 + .3,

            alpha: Math.random(),

            speed: Math.random() * .009 + .002,

            direction: Math.random() > .5 ? 1 : -1

        }));

    }

    function animate() {

        ctx.clearRect(
            0,
            0,
            innerWidth,
            innerHeight
        );

        stars.forEach(star => {

            star.alpha += star.speed * star.direction;

            if (star.alpha >= 1 || star.alpha <= .15) {
                star.direction *= -1;
            }

            ctx.beginPath();

            ctx.arc(
                star.x,
                star.y,
                star.radius,
                0,
                Math.PI * 2
            );

            ctx.fillStyle =
                `rgba(210,220,255,${star.alpha})`;

            ctx.fill();

        });

        requestAnimationFrame(animate);

    }

    resize();

    window.addEventListener("resize", resize);

    animate();

}
