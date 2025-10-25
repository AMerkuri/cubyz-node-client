# Cubyz Node.js Client Library

`cubyz-node-client` is a small TypeScript library that speaks the Cubyz networking protocol from Node.js. It exposes a high-level `CubyzConnection` class for establishing a UDP session with a running Cubyz server, handling the handshake, managing sequenced channels, and publishing client state packets.

## Features

- Typed wrapper around the Cubyz UDP protocol (init negotiation, confirmations, keep-alives)
- Full handshake implementation and spawn data parsing
- Helpers for sending chat messages, teleport updates, and rotation changes
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

connection.on("handshakeComplete", () => {
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
    "items"
  );
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
      update.block
    );
  }
});

connection.on("protocol", (event) => {
  console.log("Protocol event:", event.protocolId);
});

connection.on("disconnect", (details) => {
  console.log("Server closed connection", details.reason);
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
  version?: string; // Protocol version (default: "0.0.0")
  logger?: CubyzConnectionLogger; // Custom logger (default: no-op)
  logLevel?: LogLevel; // "debug" | "info" | "warn" | "error" | "silent"
}
```

#### Events

- **`connected`**: Emitted when the channel handshake with the server completes
- **`handshakeComplete()`**: Emitted when the server handshake finishes and the bot is ready
- **`chat(message: string)`**: Emitted when a chat message is received from the server
- **`blockUpdate(updates: BlockUpdate[])`**: Emitted when blocks are placed or broken (includes position, block ID, and optional block entity data)
- **`players(players: PlayerData[])`**: Emitted when the player list updates (each player has `id` and `name`)
- **`entityPositions(packet: EntityPositionPacket)`**: Emitted when entity/item position updates are received
- **`protocol(event: ProtocolEvent)`**: Emitted for other protocol messages
- **`disconnect(event: DisconnectEvent)`**: Emitted when the connection closes (reason: "server" | "timeout")

#### Methods

- **`async start()`**: Bind the UDP socket and initiate the connection
- **`close(options?: CloseOptions)`**: Close the connection gracefully (optionally skip server notification)
- **`sendChat(message: string)`**: Send a chat message to the server
- **`teleport(x: number, y: number, z: number)`**: Update player position
- **`setRotation(yawDeg: number, pitchDeg = 0, rollDeg = 0)`**: Update player rotation (degrees)
- **`getPlayerNames(): string[]`**: Get the current list of known player names
- **`publishPlayerState(force = false)`**: Manually send a player state update

## Key exports

### Core Classes

- **`CubyzConnection`**: High-level client with typed events for managing server connections
- **`SendChannel`**: Low-level sequenced packet sender
- **`ReceiveChannel`**: Low-level sequenced packet receiver

### ZON Parser

- **`parseZon(buffer: Buffer): ZonValue`**: Standalone ZON parser for inspecting server messages
- **`ZonValue`**: TypeScript type representing parsed ZON data structures

### Binary Utilities

- **`encodeVarInt(value: number): Buffer`**: Encode a variable-length integer
- **`decodeVarInt(buffer: Buffer, offset?: number): { value: number; bytesRead: number }`**: Decode a variable-length integer
- **`seqLessThan(a: number, b: number): boolean`**: Compare sequence numbers with wraparound handling
- **`addSeq(seq: number, delta: number): number`**: Add to a sequence number with wraparound

### Constants

- **`DEFAULT_PORT`**: Default Cubyz server port (47649)
- **`DEFAULT_VERSION`**: Default protocol version
- **`CHANNEL`**: Channel IDs (LOSSY, FAST, SLOW, etc.)
- **`PROTOCOL`**: Protocol IDs (HANDSHAKE, CHAT, ENTITY, etc.)

### TypeScript Types

```ts
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface PlayerState {
  position: Vector3;
  velocity: Vector3;
  rotation: Vector3;
}

export interface PlayerData {
  id: number;
  name: string;
}

export type PlayersEvent = PlayerData[];

export interface EntitySnapshot {
  id: number;
  position: Vector3;
  velocity: Vector3;
  rotation: Vector3;
  timestamp: number;
}

export interface ItemSnapshot {
  index: number;
  position: Vector3;
  velocity: Vector3;
  timestamp: number;
}

export interface BlockUpdate {
  position: Vector3;
  block: number; // Block type ID
  blockEntityData: Buffer; // Additional block entity data (may be empty)
}

export interface EntityPositionPacket {
  timestamp: number;
  basePosition: Vector3;
  entities: EntitySnapshot[];
  items: ItemSnapshot[];
}

export interface ProtocolEvent {
  channelId: number;
  protocolId: number;
  payload: Buffer;
}

export interface DisconnectEvent {
  reason: "server" | "timeout";
}

export interface CloseOptions {
  notify?: boolean; // Send disconnect packet to server (default: true)
}
```

## Development

- **`npm run build`**: Compile TypeScript sources to `dist/`
- **`npm run clean`**: Remove the `dist/` output directory
- **`npm run sandbox`**: Build and run the sandbox example
- **`npm run check`**: Run Biome linter/formatter checks
- **`npm run check:write`**: Auto-fix linting and formatting issues

## Project Structure

```
src/
  index.ts          - Main exports
  connection.ts     - CubyzConnection class
  send_channel.ts   - Sequenced packet sender
  receive_channel.ts - Sequenced packet receiver
  binary.ts         - Binary encoding/decoding utilities
  zon.ts           - ZON format parser
  constants.ts      - Protocol constants
sandbox/
  main.ts          - Example usage
```

## Acknowledgments

This project was created with the assistance of LLMs (GPT-5 Codex and Claude Sonnet 4.5).
