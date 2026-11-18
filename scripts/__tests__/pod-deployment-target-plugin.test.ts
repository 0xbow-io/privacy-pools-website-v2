// The config plugin that lifts pod targets to the app's iOS deployment target.
// Xcode 27 fails the build on any target below iOS 15, and two pods' resource
// bundles still declare 12.4 and 13.4.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { raisePodDeploymentTargets } = require('../../plugins/with-pod-deployment-target') as {
  raisePodDeploymentTargets: (podfile: string) => string;
};

// The post_install block as `expo prebuild` writes it for SDK 56.
const PODFILE = `platform :ios, podfile_properties['ios.deploymentTarget'] || '16.4'

target 'privacypools' do
  use_expo_modules!

  post_install do |installer|
    react_native_post_install(
      installer,
      config[:reactNativePath],
      :mac_catalyst_enabled => false,
      :ccache_enabled => ccache_enabled?(podfile_properties),
    )
  end
end
`;

test('the lift runs at the end of post_install and only ever raises a target', () => {
  expect(raisePodDeploymentTargets(PODFILE)).toBe(`platform :ios, podfile_properties['ios.deploymentTarget'] || '16.4'

target 'privacypools' do
  use_expo_modules!

  post_install do |installer|
    react_native_post_install(
      installer,
      config[:reactNativePath],
      :mac_catalyst_enabled => false,
      :ccache_enabled => ccache_enabled?(podfile_properties),
    )
    # ppv2: pod deployment target
    app_target = podfile_properties['ios.deploymentTarget'] || '16.4'
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build|
        current = build.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current && Gem::Version.new(current) < Gem::Version.new(app_target)
          build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = app_target
        end
      end
    end
  end
end
`);
});

test('applying it twice changes nothing', () => {
  const once = raisePodDeploymentTargets(PODFILE);
  expect(raisePodDeploymentTargets(once)).toBe(once);
});

test('a Podfile without post_install fails loudly', () => {
  expect(() => raisePodDeploymentTargets("platform :ios, '16.4'\n")).toThrow('no post_install block');
});

test('app.json registers the plugin', () => {
  const app = JSON.parse(readFileSync(new URL('../../app.json', import.meta.url), 'utf8')) as { expo: { plugins: unknown[] } };
  expect(app.expo.plugins).toContain('./plugins/with-pod-deployment-target');
});
