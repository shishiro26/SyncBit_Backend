import IOREDIS from "ioredis";

const redisConnection = new IOREDIS({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
});

export default redisConnection;
