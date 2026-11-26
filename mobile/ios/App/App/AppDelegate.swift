import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // A chat's notification has a Reply button with a text field (the server marks those "reply": backend/src/push.ts).
        let reply = UNTextInputNotificationAction(identifier: "reply", title: "Reply", options: [], textInputButtonTitle: "Send", textInputPlaceholder: "Reply to Emplio")
        let center = UNUserNotificationCenter.current()
        center.setNotificationCategories([UNNotificationCategory(identifier: "reply", actions: [reply], intentIdentifiers: [], options: [])])
        // set here, not by Capacitor (handleApplicationNotifications: false), so a reply reaches the app even when it wasn't running
        center.delegate = self
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    // --- notifications ---------------------------------------------------------------------------------
    // A reply is sent from here, without opening the app or waiting for the page: the notification carries a token for
    // that chat and where to send it. Everything else (a tap opening the chat) goes to Capacitor and on to the page.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        guard response.actionIdentifier == "reply", let input = response as? UNTextInputNotificationResponse else {
            return withRouter({ $0.userNotificationCenter(center, didReceive: response, withCompletionHandler: completionHandler) }, orElse: completionHandler)
        }
        let text = input.userText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let token = info["reply"] as? String, let url = (info["replyUrl"] as? String).flatMap(URL.init(string:)) else { return completionHandler() }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token, "text": text])
        let task = UIApplication.shared.beginBackgroundTask(withName: "reply")
        URLSession.shared.dataTask(with: request) { _, res, _ in
            if (res as? HTTPURLResponse)?.statusCode != 200 { self.replyFailed(text) }
            DispatchQueue.main.async {
                completionHandler()
                UIApplication.shared.endBackgroundTask(task)
            }
        }.resume()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        withRouter({ $0.userNotificationCenter(center, willPresent: notification, withCompletionHandler: completionHandler) }, orElse: { completionHandler([]) })
    }

    // What was typed isn't lost: it's in the notification saying so.
    private func replyFailed(_ text: String) {
        let note = UNMutableNotificationContent()
        note.title = "Your reply didn't send"
        note.body = "Open Emplio and send it again: \(text)"
        note.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: note, trigger: nil))
    }

    // Capacitor's router, once the page's bridge is up: an app opened by a tap gets the tap before it has one.
    private func withRouter(_ run: @escaping (NotificationRouter) -> Void, orElse: @escaping () -> Void, tries: Int = 100) {
        if let router = (window?.rootViewController as? CAPBridgeViewController)?.bridge?.notificationRouter { return run(router) }
        if tries == 0 { return orElse() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.withRouter(run, orElse: orElse, tries: tries - 1) }
    }
}

// --- the tab bar ----------------------------------------------------------------------------------------------------
// The app's screen (Main.storyboard opens it): the site, with a real iPhone tab bar over its bottom, Liquid Glass on
// iOS 26. The site fills it in and moves between pages when a tab is tapped (frontend/src/components/chat/bottom-tabs.tsx);
// a site without that, or an app build without this, keeps the site's own tab bar.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(TabBarPlugin())
        bridge?.registerPluginInstance(ZoomPlugin())
    }
}

// Pinch-zoom off, as on an app's own screens, and back on while a file is open (frontend/src/lib/zoom.ts).
// Capacitor stops pinches itself (its scroll view delegate), but the Keyboard plugin takes that delegate over to keep
// the page from shifting (capacitor.config.js scrollEnabled: false), which let the whole app zoom. This takes it
// back and does both. The web view turns the pinch on again whenever it likes, so it's stopped as each one starts.
@objc(ZoomPlugin)
public class ZoomPlugin: CAPPlugin, CAPBridgedPlugin, UIScrollViewDelegate {
    public let identifier = "ZoomPlugin"
    public let jsName = "Zoom"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise)]
    private var allowed = false

    @objc func set(_ call: CAPPluginCall) {
        let allowed = call.getBool("allowed") ?? false
        DispatchQueue.main.async {
            self.allowed = allowed
            guard let scroll = self.bridge?.webView?.scrollView else { return call.resolve() }
            scroll.delegate = self
            scroll.pinchGestureRecognizer?.isEnabled = allowed
            // closing a file while zoomed in: back to the normal size
            if !allowed && scroll.zoomScale != scroll.minimumZoomScale { scroll.setZoomScale(scroll.minimumZoomScale, animated: true) }
            call.resolve()
        }
    }

    public func scrollViewWillBeginZooming(_ scrollView: UIScrollView, with view: UIView?) {
        if !allowed { scrollView.pinchGestureRecognizer?.isEnabled = false }
    }

    // what the Keyboard plugin did: the page itself never scrolls (each screen scrolls inside); a zoomed-in file
    // still pans
    public func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if !scrollView.isScrollEnabled && scrollView.zoomScale <= scrollView.minimumZoomScale && scrollView.contentOffset != .zero {
            scrollView.setContentOffset(.zero, animated: false)
        }
    }
}

@objc(TabBarPlugin)
public class TabBarPlugin: CAPPlugin, CAPBridgedPlugin, UITabBarDelegate {
    public let identifier = "TabBarPlugin"
    public let jsName = "TabBar"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise)]

    // a vivid take on the app's green, for the selected tab: the brand's own deep green looked dull on the glass.
    // ponytail: picked by eye; tune here
    private static let brand = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x3c / 255, green: 0xcf / 255, blue: 0x86 / 255, alpha: 1)
            : UIColor(red: 0x1f / 255, green: 0x9d / 255, blue: 0x5c / 255, alpha: 1)
    }
    private let bar = UITabBar()
    private var ids: [String] = []

    // The whole state at once: tabs [{id, title, icon (an SF Symbol), badge?}], the selected id, and whether it shows
    // (not while typing or with a sheet or menu open). Answers the bar's height, for the page to keep clear of.
    @objc func set(_ call: CAPPluginCall) {
        let tabs = call.getArray("tabs", JSObject.self) ?? []
        let selected = call.getString("selected")
        let visible = call.getBool("visible") ?? true
        DispatchQueue.main.async {
            guard let view = self.bridge?.viewController?.view else { return call.reject("no screen yet") }
            if self.bar.superview == nil {
                self.bar.delegate = self
                self.bar.tintColor = TabBarPlugin.brand
                self.bar.isHidden = true
                self.bar.translatesAutoresizingMaskIntoConstraints = false
                view.addSubview(self.bar)
                NSLayoutConstraint.activate([
                    self.bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                    self.bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                    self.bar.bottomAnchor.constraint(equalTo: view.bottomAnchor),
                ])
            }
            // no tabs: just hiding (the page going away), the items stay for when it's back
            let ids = tabs.isEmpty ? self.ids : tabs.compactMap { $0["id"] as? String }
            // new items only when the tabs themselves change: replacing them every time would cut the glass's own
            // animation when the selection moves, and replay it from the first tab (it danced at launch)
            let fresh = ids != self.ids
            if fresh {
                self.ids = ids
                self.bar.items = tabs.enumerated().map { i, tab in
                    UITabBarItem(title: tab["title"] as? String, image: UIImage(systemName: tab["icon"] as? String ?? "circle"), tag: i)
                }
            }
            for (item, tab) in zip(self.bar.items ?? [], tabs) where !tabs.isEmpty {
                // "" is a dot (working, or something new)
                item.badgeValue = tab["badge"] as? String
                item.badgeColor = TabBarPlugin.brand
            }
            let index = selected.flatMap { ids.firstIndex(of: $0) }
            let item = index.map { self.bar.items![$0] }
            // only when it moved: setting it again replays the glass's selection, a flicker on every badge update.
            // Straight there, no glide, while the bar is hidden or just filled in: at launch it slid in from nowhere
            if self.bar.selectedItem !== item {
                if fresh || self.bar.isHidden { UIView.performWithoutAnimation { self.bar.selectedItem = item; self.bar.layoutIfNeeded() } }
                else { self.bar.selectedItem = item }
            }
            if self.bar.isHidden == visible {
                UIView.transition(with: self.bar, duration: 0.2, options: .transitionCrossDissolve) { self.bar.isHidden = !visible }
            }
            view.layoutIfNeeded()
            call.resolve(["height": visible ? self.bar.frame.height : 0])
        }
    }

    public func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        guard item.tag < ids.count else { return }
        notifyListeners("select", data: ["id": ids[item.tag]])
    }
}
