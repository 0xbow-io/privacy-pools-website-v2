// Raise every pod target to the app's iOS deployment target.
//
// Xcode 27 refuses an iOS deployment target below 15.0, and some pods still
// declare older ones on their resource-bundle targets: react-native-svg 15.15
// (RNSVGFilters, 12.4) and @react-native-async-storage/async-storage 2.x
// (RNCAsyncStorage_resources, 13.4). CocoaPods gives those targets the pod's
// own minimum rather than the app's, so the build fails before compiling.
// Pods never run on an older iOS than the app does, so lifting them to the
// app's target changes nothing at runtime.
const { withPodfile } = require('expo/config-plugins');

const MARKER = '# ppv2: pod deployment target';

const SNIPPET = `
    ${MARKER}
    app_target = podfile_properties['ios.deploymentTarget'] || '16.4'
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build|
        current = build.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current && Gem::Version.new(current) < Gem::Version.new(app_target)
          build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = app_target
        end
      end
    end`;

/** Insert the snippet at the end of the post_install block, once. */
function raisePodDeploymentTargets(podfile) {
  if (podfile.includes(MARKER)) return podfile;
  const match = /\n(\s*)post_install do \|installer\|\n[\s\S]*?\n\1end\n/.exec(podfile);
  if (!match) throw new Error('with-pod-deployment-target: no post_install block in the Podfile');
  const blockEnd = match.index + match[0].length - `${match[1]}end\n`.length;
  return `${podfile.slice(0, blockEnd)}${SNIPPET.slice(1)}\n${podfile.slice(blockEnd)}`;
}

module.exports = (config) => withPodfile(config, (podfileConfig) => {
  podfileConfig.modResults.contents = raisePodDeploymentTargets(podfileConfig.modResults.contents);
  return podfileConfig;
});
module.exports.raisePodDeploymentTargets = raisePodDeploymentTargets;
