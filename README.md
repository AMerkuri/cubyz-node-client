# Cubyz Node.js Client Library

`cubyz-node-client` is a TypeScript library that speaks the Cubyz networking protocol from Node.js. It exposes a high-level `CubyzConnection` class for establishing a UDP session with a running Cubyz server, handling the TLS 1.3 + ed25519 authenticated handshake, managing sequenced channels, and publishing client state packets.

## Features

- Typed wrapper around the Cubyz UDP protocol (init negotiation, confirmations, keep-alives)
- Full TLS 1.3 handshake implementation (manual, no system TLS required) with ed25519/P-256/ML-DSA-44 identity signing
- Persistent identity file — bot identity is created once and reused across sessions
- Spawn data parsing from server ZON payload
- Helpers for chat, teleport, and rotation changes
- Lightweight ZON parser for decoding server payloads without bundling Zig tooling
- Designed for embedding in other tooling, bots, or integration tests
- Configurable log level with typed disconnect events when the server closes the session

## Requirements

- Node.js 18 or newer (modern UDP & BigInt APIs)
- Access to a Cubyz server (default UDP port `47649`)

## Installation

```bash
npm install cubyz-node-client
```

## Building from source

```bash
npm install
npm run build
```

Compilation outputs ESM modules alongside type declarations in `dist/`.

## Quick start example

You can run the included sandbox example to see the connection flow:

```bash
# Optional overrides for host/port/player name
export CUBYZ_HOST=127.0.0.1
export CUBYZ_PORT=47649
export CUBYZ_NAME=ExampleBot
export CUBYZ_LOG_LEVEL=debug

npm run sandbox
```

The example connects to the configured server, logs chat/player events, emits a greeting, and stays connected until interrupted with Ctrl+C.

## Programmatic usage

```ts
import { CubyzConnection, DEFAULT_PORT } from "cubyz-node-client";

const connection = new CubyzConnection({
  host: "127.0.0.1",
  port: DEFAULT_PORT,
  name: "ToolingBot",
  logger: console,
  logLevel: "warn",
});

connection.on("connected", () => {
  console.log("Channel handshake ready");
});

connection.on("handshakeComplete", (serverData) => {
  console.log("Handshake complete, bot is ready!");
  connection.sendChat("Hello world from tooling!");
});

connection.on("players", (players) => {
  console.log("Known players:", players);
});

connection.on("entityPositions", (packet) => {
  console.log(
    "Entity update:",
    packet.entities.length,
    "entities,",
    packet.items.length,
    "items",
  );
});

connection.on("genericUpdate", (update) => {
  if (update.type === "teleport") {
    console.log("Teleported to", update.position);
  } else if (update.type === "time") {
    console.log("World time:", update.time);
  }
});

connection.on("chat", (message) => {
  console.log("[chat]", message);
});

connection.on("blockUpdate", (updates) => {
  for (const update of updates) {
    console.log(
      "Block changed at",
      update.position,
      "to block ID",
      update.block,
    );
  }
});

connection.on("protocol", (event) => {
  console.log("Raw protocol event:", event.protocolId);
});

connection.on("disconnect", (details) => {
  console.log("Server closed connection:", details.reason);
});

await connection.start();

// Later: connection.close();
```

## API Reference

### CubyzConnection

#### Constructor Options

```ts
interface CubyzConnectionOptions {
  host: string; // Server hostname or IP
  port: number; // Server UDP port (default: 47649)
  name: string; // Player/bot name
  version?: string; // Protocol version (default: "0.3.0")
  logger?: CubyzConnectionLogger; // Custom logger (default: console)
  logLevel?: LogLevel; // "debug" | "info" | "warn" | "error" | "silent"
  identityFile?: string; // Path to persist the bot's key pair (default: "./cubyz-identity.txt")
}
```

The `identityFile` is created automatically on first run and reused on subsequent connections, giving the bot a stable cryptographic identity.

#### Events

- **`connected`**: Emitted when the UDP channel handshake with the server completes (before TLS/auth).
- **`handshakeComplete(serverData: string)`**: Emitted when the full authenticated handshake finishes and the bot is in the world. `serverData` is the server's ZON payload containing spawn position, player ID, etc.
- **`chat(message: string)`**: Emitted when a chat message is received.
- **`players(players: PlayerData[])`**: Emitted when the player list changes. Each entry has `id: number` and `name: string`.
- **`entityPositions(packet: EntityPositionPacket)`**: Emitted when entity/item-drop position updates arrive (lossy channel, high frequency).
- **`blockUpdate(updates: BlockUpdate[])`**: Emitted when blocks are placed or broken. Each entry includes position, block ID, and optional block entity data.
- **`genericUpdate(update: GenericUpdate)`**: Emitted for server-pushed state changes. The `update.type` discriminant selects the variant:
  - `"gamemode"` — `{ gamemode: 0 | 1 }` (survival / creative)
  - `"teleport"` — `{ position: Vector3 }`
  - `"worldEditPos"` — `{ positionType: 0 | 1 | 2, position: Vector3 | null }`
  - `"time"` — `{ time: bigint }` (world game time)
  - `"biome"` — `{ biomeId: number }`
  - `"particles"` — `{ particleId: string, position: Vector3, collides: boolean, count: number, spawnZon: string }`
  - `"clear"` — `{ clearType: "chat" }` (server requests clearing the chat)
- **`protocol(event: ProtocolEvent)`**: Emitted for every protocol message (raw access, fires in addition to the typed events above).
- **`disconnect(event: DisconnectEvent)`**: Emitted when the connection closes. `reason` is `"server"` or `"timeout"`.

#### Methods

- **`async start(): Promise<void>`**: Bind the UDP socket and initiate the connection. Resolves once the socket is listening; events fire asynchronously afterwards.
- **`close(options?: CloseOptions)`**: Close the connection. By default sends a disconnect packet to the server first; pass `{ notify: false }` to skip it.
- **`sendChat(message: string)`**: Send a chat message.
- **`teleport(x: number, y: number, z: number)`**: Set player position and clear velocity.
- **`setRotation(yawDeg: number, pitchDeg?: number, rollDeg?: number)`**: Set player rotation (values in degrees).
- **`publishPlayerState(force?: boolean)`**: Manually push a player state packet. The connection sends these automatically on a 100 ms timer; use `force = true` to push immediately.
- **`getPlayers(): PlayerData[]`**: Return the current known player list.
- **`getPlayerNames(): string[]`**: Return the current known player names.
- **`getEntityStates(): EntitySnapshot[]`**: Return a snapshot of all currently tracked entity positions.
- **`getEntityState(id: number): EntitySnapshot | undefined`**: Return the latest snapshot for a specific entity.
- **`getItemStates(): ItemSnapshot[]`**: Return a snapshot of all currently tracked item-drop positions.
- **`getItemState(index: number): ItemSnapshot | undefined`**: Return the latest snapshot for a specific item drop.

## Key exports

### Core class

- **`CubyzConnection`**: High-level client with typed events.

### Constants

- **`DEFAULT_PORT`**: Default Cubyz server port (`47649`).
- **`DEFAULT_VERSION`**: Default protocol version string (`"0.3.0"`).
- **`CHANNEL`**: Channel ID constants (`LOSSY`, `SECURE`, `SLOW`, …).
- **`PROTOCOL`**: Protocol ID constants (`HANDSHAKE`, `CHAT`, `ENTITY_POSITION`, …).
- **`GAMEMODE`**: Gamemode enum values (`SURVIVAL`, `CREATIVE`).

### Chat helpers

- **`prepareChatMessage(text: string): Buffer`**: Validate and encode a chat message ready to send.
- **`countVisibleCharacters(text: string): number`**: Count visible characters for display-limit validation.

### TypeScript types

```ts
interface Vector3 {
  x: number;
  y: number;
  z: number;
}

interface PlayerData {
  id: number;
  name: string;
}
type PlayersEvent = PlayerData[];

interface EntitySnapshot {
  id: number;
  position: Vector3;
  velocity: Vector3;
  rotation: Vector3;
  timestamp: number;
}

interface ItemSnapshot {
  index: number;
  position: Vector3;
  velocity: Vector3;
  timestamp: number;
}

interface BlockUpdate {
  position: Vector3;
  block: number; // Block type ID
  blockEntityData: Buffer; // May be empty (zero length)
}

interface EntityPositionPacket {
  timestamp: number;
  basePosition: Vector3;
  entities: EntitySnapshot[];
  items: ItemSnapshot[];
}

type GenericUpdate =
  | GamemodeUpdate
  | TeleportUpdate
  | WorldEditPosUpdate
  | TimeUpdate
  | BiomeUpdate
  | ParticlesUpdate
  | ClearUpdate;

interface ProtocolEvent {
  channelId: number;
  protocolId: number;
  payload: Buffer;
}

interface DisconnectEvent {
  reason: "server" | "timeout";
}
interface CloseOptions {
  notify?: boolean;
}
```

## Development

- **`npm run build`**: Compile TypeScript sources to `dist/`.
- **`npm run clean`**: Remove the `dist/` output directory.
- **`npm run sandbox`**: Build and run the sandbox example.
- **`npm run check`**: Run Biome linter/formatter checks.
- **`npm run check:write`**: Auto-fix linting and formatting issues.

## Project Structure

```
src/
  index.ts          - Public API barrel
  connection.ts     - CubyzConnection class and protocol handlers
  connectionTypes.ts - Shared interfaces and event type definitions
  constants.ts      - Protocol constants (channels, protocol IDs, timeouts)
  entityParser.ts   - Binary entity/item position packet parser
  secureChannel.ts  - Manual TLS 1.3 handshake over UDP
  sendChannel.ts    - Sequenced reliable packet sender
  receiveChannel.ts - Sequenced reliable packet receiver with reorder buffer
  authentication.ts - Identity management and ed25519/P-256/ML-DSA-44 signing
  handshakeUtils.ts - Handshake payload encoding helpers
  binary.ts         - MSB-varint, float-16, and sequence-number utilities
  chatFormat.ts     - Chat message validation and encoding
  zon.ts            - Lightweight ZON format parser
sandbox/
  main.ts           - Example bot
```

## Acknowledgments

This project was created with the assistance of LLMs (GPT-5 Codex and Claude Sonnet 4.5/4.6).
