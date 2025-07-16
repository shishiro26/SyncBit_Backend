export function sendUnicast(socket, event, data) {
  socket.emit(event, data);
}

export function sendBroadcast(io, roomId, event, data) {
  io.to(roomId).emit(event, data);
}
