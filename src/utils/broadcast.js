export function sendUnicast(socket, event, data) {
  socket.emit(event, data);
}

export function sendBroadCast(io, roomId, event, data) {
  io.to(roomId).emit(event, data);
}
