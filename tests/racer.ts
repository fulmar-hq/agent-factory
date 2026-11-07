import { Store } from "../tracking/store";
import { Engine } from "../launcher/engine";
import { config, ticket, admission } from "./fixtures";
const [path, n, mode, gate] = process.argv.slice(2),
  s = new Store(path),
  c = config();
if (mode === "slot") c.capacity.start_parallel = 1;
while (!(await Bun.file(gate).exists())) await Bun.sleep(5);
try {
  const t = ticket(Number(n));
  t.costCents = mode === "dollar" ? 100 : 0;
  new Engine(s, c).admit(t, admission());
  console.log("admitted");
} catch {
  console.log("refused");
} finally {
  s.close();
}
