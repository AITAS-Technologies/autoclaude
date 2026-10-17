// Spawns a long-sleeping grandchild, prints its pid, then sleeps itself.
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
console.log(String(child.pid));
setTimeout(() => {}, 60000);
