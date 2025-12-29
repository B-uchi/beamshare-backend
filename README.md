# BeamShare - Signaling Server

The lightweight signaling backend for **BeamShare**, facilitating peer discovery and WebRTC handshakes.

### 🛠 Tech Stack
- **Runtime:** [Node.js](https://nodejs.org/)
- **Communication:** [`ws`](https://github.com/websockets/ws) (WebSocket library)
- **Security:** [`jsonwebtoken`](https://github.com/auth0/node-jsonwebtoken) (JWT)

### 📂 Module Overview
- **`server.js`**: The central signaling hub. It performs:
  - **Authentication**: Validates clients via JSON Web Tokens before allowing session entry.
  - **Session Management**: Orchestrates session creation, joining, and cleanup.
  - **Signaling Relay**: Forwards WebRTC offers, answers, and ICE candidates between peers to establish P2P connections.
  - **Fallback Transport**: Provides a basic file-chunk broadcasting mechanism for clients as a fallback.
  - **Reconnection Logic**: Manages client timeouts (10s for hosts, 5s for peers) and session persistence during brief disconnects.

### 🚀 Setup
1. **Install Dependencies**:
   ```bash
   npm install
   ```
2. **Environment Configuration**:
   Create a `.env` file in this directory:
   ```env
   PORT=8080
   JWT_SECRET=your_super_secret_here
   ```
3. **Run the Server**:
   ```bash
   node server.js
   ```

---
*The bridge that connects users for seamless P2P sharing.*
