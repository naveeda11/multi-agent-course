import { NeonRepository } from "../src/gate/neon-repository.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for Tier 3 migration");
}

const repository = new NeonRepository({ connectionString });
try {
  await repository.migrate();
  process.stdout.write("Tier 3 database migration completed.\n");
} finally {
  await repository.close();
}
