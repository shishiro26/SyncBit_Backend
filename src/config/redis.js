import IORedis from "ioredis";

const redisConnection = new IORedis({
  host: "localhost",
  port: 6379,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export default redisConnection;
