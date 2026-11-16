export async function deleteVerifiedBackupWithRetention({
  storage,
  key,
  persistPending,
  persistDeleted,
  persistDeleteFailure,
  persistMetadataFailure,
}) {
  await persistPending();
  try {
    await storage.delete(key);
  } catch (error) {
    await persistDeleteFailure(error);
    throw error;
  }
  try {
    await persistDeleted();
  } catch (error) {
    await persistMetadataFailure(error);
    throw error;
  }
  return true;
}
