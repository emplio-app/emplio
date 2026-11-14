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
