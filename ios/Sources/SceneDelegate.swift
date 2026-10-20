import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = DockViewController()
        window.makeKeyAndVisible()
        self.window = window
        keepScreenAwake()
    }

    // The phone screen must never sleep while WinDock is open (connection screen included).
    // iOS restores the system idle timer on its own when the app goes to the background.
    func sceneWillEnterForeground(_ scene: UIScene) { keepScreenAwake() }
    func sceneDidBecomeActive(_ scene: UIScene) { keepScreenAwake() }

    private func keepScreenAwake() {
        UIApplication.shared.isIdleTimerDisabled = true
    }
}
