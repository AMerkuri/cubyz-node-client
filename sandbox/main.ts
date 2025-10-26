import path from "node:path";
import { fileURLToPath } from "node:url";

// When published, replace the relative import with: `import { CubyzConnection } from "cubyz-node-client";`
import { CubyzConnection, DEFAULT_PORT, GAMEMODE } from "../dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const host = process.env.CUBYZ_HOST ?? "127.0.0.1";
const port = Number(process.env.CUBYZ_PORT ?? DEFAULT_PORT);
const name = process.env.CUBYZ_NAME ?? "ExampleBot";
const logLevel = (process.env.CUBYZ_LOG_LEVEL ?? "debug").toLowerCase() as
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "silent";

async function main() {
  const connection = new CubyzConnection({
    host,
    port,
    name,
    logger: console,
    logLevel,
  });

  connection.on("connected", () => {
    console.log(`Connected to ${host}:${port}, waiting for handshake...`);
  });

  connection.on("handshakeComplete", () => {
    console.log("Handshake finished, sending greeting chat message...");
    connection.sendChat("Hello from the cubyz-node-client example!");
    // setTimeout(() => {
    //   console.log("Closing connection after demo");
    //   connection.close();
    // }, 5000).unref?.();
  });

  connection.on("players", (players) => {
    if (players.length === 0) {
      console.log("[players] none known yet");
      return;
    }
    console.log(
      `[players] ${players.map((p) => `${p.id}:${p.name}`).join(", ")}`,
    );
  });

  connection.on("chat", (message) => {
    console.log(`[chat] ${message}`);
  });

  connection.on("blockUpdate", (updates) => {
    for (const update of updates) {
      console.log({ update });
    }
  });

  connection.on("disconnect", (event) => {
    console.log(`[disconnect] reason=${event.reason}`);
  });

  connection.on("entityPositions", (_packet) => {
    // Uncomment to log all entity position packets (very spammy)
    // console.log(`[entityPositions] timestamp=${packet.timestamp} entities=${packet.entities.length} items=${packet.items.length}`);
  });

  connection.on("genericUpdate", (update) => {
    switch (update.type) {
      case "gamemode": {
        const modeName =
          update.gamemode === GAMEMODE.SURVIVAL ? "Survival" : "Creative";
        console.log(
          `[genericUpdate] gamemode changed to ${modeName} (${update.gamemode})`,
        );
        break;
      }
      case "teleport":
        console.log(
          `[genericUpdate] teleported to (${update.position.x}, ${update.position.y}, ${update.position.z})`,
        );
        break;
      case "worldEditPos":
        if (update.position) {
          console.log(
            `[genericUpdate] world edit position ${update.positionType} set to (${update.position.x}, ${update.position.y}, ${update.position.z})`,
          );
        } else {
          console.log("[genericUpdate] world edit positions cleared");
        }
        break;
      case "time":
        console.log(`[genericUpdate] game time updated to ${update.time}`);
        break;
      case "biome":
        console.log(`[genericUpdate] biome changed to ID ${update.biomeId}`);
        break;
    }
  });

  // connection.on("protocol", (event) => {
  //   console.log(
  //     `[protocol] channelId=${event.channelId} protocolId=${event.protocolId} payloadLen=${event.payload.length}`,
  //   );
  // });

  process.once("SIGINT", () => {
    console.log("Received SIGINT, shutting down...");
    connection.close();
  });

  await connection.start();
}

main().catch((err) => {
  console.error("Example failed:", err);
  process.exitCode = 1;
});
