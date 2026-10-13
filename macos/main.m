#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface AppDelegate : NSObject <NSApplicationDelegate, WKUIDelegate>
@property (strong, nonatomic) NSWindow *window;
@property (strong, nonatomic) WKWebView *webView;
@property (strong, nonatomic) NSTask *serverTask;
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setAppearance:[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua]];
    [self ensureBackendServerRunning];

    NSRect frame = NSMakeRect(0, 0, 1180, 780);
    NSWindowStyleMask style = NSWindowStyleMaskTitled |
                              NSWindowStyleMaskClosable |
                              NSWindowStyleMaskMiniaturizable |
                              NSWindowStyleMaskResizable |
                              NSWindowStyleMaskFullSizeContentView;

    self.window = [[NSWindow alloc] initWithContentRect:frame
                                              styleMask:style
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    [self.window center];
    [self.window setTitle:@"Vanaras"];
    [self.window setTitlebarAppearsTransparent:YES];
    [self.window setTitleVisibility:NSWindowTitleHidden];
    [self.window setBackgroundColor:[NSColor colorWithSRGBRed:0.05 green:0.05 blue:0.05 alpha:1.0]];

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    [config setApplicationNameForUserAgent:@"VanarasNativeMacApp/2.0"];
    [config.preferences setValue:@YES forKey:@"developerExtrasEnabled"];

    self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:config];
    [self.webView setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
    [self.webView setUIDelegate:self];
    [self.webView setValue:@NO forKey:@"drawsBackground"];

    [self.window.contentView addSubview:self.webView];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];

    [self loadAppWithRetry:10];
}

- (void)loadAppWithRetry:(NSInteger)attempts {
    NSURL *url = [NSURL URLWithString:@"http://localhost:3000"];
    NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithURL:url completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            NSHTTPURLResponse *httpResp = (NSHTTPURLResponse *)response;
            if (httpResp && httpResp.statusCode == 200) {
                [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
            } else if (attempts > 1) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.35 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                    [self loadAppWithRetry:attempts - 1];
                });
            } else {
                [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
            }
        });
    }];
    [task resume];
}

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
    NSAlert *alert = [[NSAlert alloc] init];
    [alert setMessageText:@"Vanaras"];
    [alert setInformativeText:message];
    [alert addButtonWithTitle:@"OK"];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse returnCode) {
        completionHandler();
    }];
}

- (void)webView:(WKWebView *)webView runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt defaultText:(NSString *)defaultText initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSString *))completionHandler {
    NSAlert *alert = [[NSAlert alloc] init];
    [alert setMessageText:prompt];
    [alert addButtonWithTitle:@"OK"];
    [alert addButtonWithTitle:@"Cancel"];
    NSTextField *input = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 320, 24)];
    [input setStringValue:defaultText ?: @""];
    [alert setAccessoryView:input];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse returnCode) {
        if (returnCode == NSAlertFirstButtonReturn) {
            completionHandler([input stringValue]);
        } else {
            completionHandler(nil);
        }
    }];
}

- (void)ensureBackendServerRunning {
    NSString *bundlePath = [[NSBundle mainBundle] bundlePath];
    NSString *vanarasDir = [bundlePath stringByDeletingLastPathComponent];
    NSString *serverScript = [vanarasDir stringByAppendingPathComponent:@"ui/server.mjs"];
    if (![[NSFileManager defaultManager] fileExistsAtPath:serverScript]) {
        return;
    }

    NSArray *nodeCandidates = @[
        @"/Users/lakshmipriyasridharan/.nvm/versions/node/v20.19.5/bin/node",
        @"/usr/local/bin/node",
        @"/opt/homebrew/bin/node"
    ];
    NSString *nodeBin = nil;
    for (NSString *candidate in nodeCandidates) {
        if ([[NSFileManager defaultManager] isExecutableFileAtPath:candidate]) {
            nodeBin = candidate;
            break;
        }
    }
    if (!nodeBin) return;

    self.serverTask = [[NSTask alloc] init];
    [self.serverTask setExecutableURL:[NSURL fileURLWithPath:nodeBin]];
    [self.serverTask setArguments:@[serverScript]];
    [self.serverTask setCurrentDirectoryURL:[NSURL fileURLWithPath:vanarasDir]];
    @try {
        [self.serverTask launchAndReturnError:nil];
    } @catch (NSException *exception) {}
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    if (self.serverTask && [self.serverTask isRunning]) {
        [self.serverTask terminate];
    }
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        [app setDelegate:delegate];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        [app run];
    }
    return 0;
}
