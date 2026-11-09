describe('unit test fetch boundary', () => {
  it('rejects requests instead of reaching the host network', async () => {
    await expect(fetch('data:,unused')).rejects.toThrow('Unexpected network request in unit test');
  });

  it('keeps blocking requests after Jest mocks are reset', async () => {
    jest.resetAllMocks();

    await expect(fetch('data:,unused')).rejects.toThrow('Unexpected network request in unit test');
  });
});
