import duckdb from "duckdb";

// One operation per process: exit releases even native handles retained by the binding.
process.once("message", async ({ path, kind, sql, values }) => {
  try {
    const db = await new Promise((resolve, reject) => {
      const database = new duckdb.Database(path, (error) => error ? reject(error) : resolve(database));
    });
    const connection = db.connect();
    const rows = await new Promise((resolve, reject) => {
      const done = (error, result) => error ? reject(error) : resolve(kind === "all" ? result : undefined);
      if (kind === "exec") connection.exec(sql, done);
      else connection[kind](sql, ...values, done);
    });
    // Commit/checkpoint before reporting success; never kill a successful writer mid-close.
    await new Promise((resolve, reject) => connection.exec("CHECKPOINT", (error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => connection.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
    process.send({ rows }, () => process.exit(0));
  } catch (error) {
    process.send({ error: String(error) }, () => process.exit(1));
  }
});
process.once("disconnect", () => process.exit(1));
