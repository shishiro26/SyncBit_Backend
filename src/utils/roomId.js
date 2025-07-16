export function generateRoomId(length = 6) {
  let id = "";
  const digits = "0123456789";
  for (let i = 0; i < length; i++) {
    id += digits[Math.floor(Math.random() * digits.length)];
  }
  return id;
}
