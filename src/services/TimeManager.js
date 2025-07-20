import ntpClient from "ntp-client";

class TimeManager {
  constructor() {
    this.ntpOffset = 0;
    this.lastSync = 0;
    this.syncInterval = 5 * 60 * 1000;
    this.initNTPSync();
  }

  async initNTPSync() {
    try {
      await this.syncWithNTP();
      setInterval(() => this.syncWithNTP(), this.syncInterval);
    } catch (error) {
      console.error("Initial NTP sync failed:", error);
    }
  }

  syncWithNTP() {
    return new Promise((resolve, reject) => {
      ntpClient.getNetworkTime("pool.ntp.org", 123, (err, date) => {
        if (err) {
          console.error("NTP sync error:", err);
          reject(err);
          return;
        }

        const localTime = Date.now();
        const ntpTime = date.getTime();
        this.ntpOffset = ntpTime - localTime;
        this.lastSync = localTime;

        console.log(`NTP sync: offset=${this.ntpOffset}ms`);
        resolve(this.ntpOffset);
      });
    });
  }

  getServerTime() {
    return Date.now() + this.ntpOffset;
  }

  isStale() {
    return Date.now() - this.lastSync > this.syncInterval;
  }
}

const ntpManager = new TimeManager();
export default ntpManager;
