module.exports = {
  dependency: {
    platforms: {
      android: {},
      ios: {
        scriptPhases: [
          {
            name: '[Faro] Upload composed source map (Release)',
            path: './ios/faro-upload-composed-source-map.sh',
            execution_position: 'any',
          },
        ],
      },
    },
  },
};
