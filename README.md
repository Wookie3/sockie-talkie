# Sockie Talkie 📻

A full-stack, real-time "Push-to-Talk" Walkie Talkie application built with modern web technologies. It features low-latency raw audio streaming, channel management, and a retro-styled UI.

## 🚀 Features

*   **Real-Time Audio:** Low-latency, raw PCM audio streaming via WebSockets.
*   **Sample Rate Matching:** Automatically adjusts playback speed to match the sender's microphone (fixes "demon voice" issues).
*   **Push-to-Talk (PTT):** Classic half-duplex communication (one person speaks at a time).
*   **Channels/Rooms:** Join different frequency channels (e.g., "alpha-team") to chat with specific groups.
*   **Collision Prevention:** Server-side logic prevents multiple users from talking simultaneously.
*   **Retro UI:** Tactile design with CSS animations and status indicators (Transmitting, Receiving, Busy).
*   **Mobile First:** Optimized for touch devices.

## 🛠️ Tech Stack

*   **Frontend:** React, Vite, TypeScript, Tailwind CSS.
*   **Backend:** Node.js, Express, Socket.io.
*   **Audio Engine:** Web Audio API (ScriptProcessorNode) for raw buffer capture and playback.

## 📦 Project Structure

```
sockie-talkie/
├── client/         # Vite + React Frontend
│   └── app/        # Main application logic
└── server/         # Node.js + Socket.io Backend
```

## ⚡ Getting Started (Local)

### 1. Prerequisites
*   Node.js (v18+)
*   npm

### 2. Start the Server (The "Radio Tower")
The server handles room management and broadcasts audio data.

```bash
cd sockie-talkie/server
npm install
npm start
```
*Server runs on port 3001.*

### 3. Start the Client (The "Walkie Talkie")
Open a new terminal window.

```bash
cd sockie-talkie/client
npm install
npm run dev
```
*Client runs on port 5173.*

### 4. Test it!
*   Open `http://localhost:5173` in two different browser tabs/windows.
*   **Important:** Click anywhere on the page first to unlock the browser's AudioContext.
*   Hold the **PUSH TO TALK** button in one tab and listen in the other.

## 📱 Testing on Mobile (Local Wi-Fi)

1.  Find your computer's local IP address (e.g., `ipconfig` or `ifconfig`).
2.  Ensure both your PC and Phone are on the **same Wi-Fi**.
3.  On your phone, visit: `http://YOUR_PC_IP:5173`
4.  Tap the screen to unlock audio, and start talking!

## ☁️ Deployment

### Backend (Railway / Render)
Deploy the `server` directory to a persistent Node.js host.
*   **Railway:** Set "Root Directory" to `/server`.

### Frontend (Vercel)
Deploy the `client` directory to Vercel.
*   **Root Directory:** Set to `sockie-talkie/client`.
*   **Environment Variable:** Add `VITE_SERVER_URL` pointing to your deployed backend (Must be `https://`).
    *   Example: `VITE_SERVER_URL=https://my-socket-server.up.railway.app`

## 📄 License
MIT
