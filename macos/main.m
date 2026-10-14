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
    [self setupMainMenu];
    [self ensureBackendServerRunning];

    NSRect frame = NSMakeRect(0, 0, 1440, 880);
    NSWindowStyleMask style = NSWindowStyleMaskTitled |
                              NSWindowStyleMaskClosable |
                              NSWindowStyleMaskMiniaturizable |
                              NSWindowStyleMaskResizable;

    self.window = [[NSWindow alloc] initWithContentRect:frame
                                              styleMask:style
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    [self.window center];
    [self.window setTitle:@"Vanaras Pro — Multi-Agent Engineering Workbench"];
    [self.window setTitlebarAppearsTransparent:YES];
    [self.window setBackgroundColor:[NSColor colorWithSRGBRed:0.05 green:0.05 blue:0.05 alpha:1.0]];

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    [config setApplicationNameForUserAgent:@"VanarasNativeMacApp/2.1"];
    [config.preferences setValue:@YES forKey:@"developerExtrasEnabled"];

    self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:config];
    [self.webView setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
    [self.webView setUIDelegate:self];

    [self.window.contentView addSubview:self.webView];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];

    NSSet *dataTypes = [NSSet setWithObjects:WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache, nil];
    [[WKWebsiteDataStore defaultDataStore] removeDataOfTypes:dataTypes
                                               modifiedSince:[NSDate distantPast]
                                           completionHandler:^{
        [self loadAppWithRetry:10];
    }];
}

- (void)setupMainMenu {
    NSMenu *menubar = [[NSMenu alloc] init];
    NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:appMenuItem];
    NSMenu *appMenu = [[NSMenu alloc] init];
    [appMenu addItemWithTitle:@"Reload Workspace" action:@selector(reloadWebView:) keyEquivalent:@"r"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"Quit Vanaras" action:@selector(terminate:) keyEquivalent:@"q"];
    [appMenuItem setSubmenu:appMenu];

    NSMenuItem *editMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:editMenuItem];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    [editMenu addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
    [editMenu addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"Z"];
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
    [editMenuItem setSubmenu:editMenu];

    [NSApp setMainMenu:menubar];
}

- (void)reloadWebView:(id)sender {
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://localhost:3000/?v=%ld", (long)[[NSDate date] timeIntervalSince1970]]];
    [self.webView loadRequest:[NSURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:10.0]];
}

- (void)loadAppWithRetry:(NSInteger)attempts {
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://localhost:3000/?v=%ld", (long)[[NSDate date] timeIntervalSince1970]]];
    NSURLRequest *req = [NSURLRequest requestWithURL:url
                                         cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                     timeoutInterval:10.0];
    NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            NSHTTPURLResponse *httpResp = (NSHTTPURLResponse *)response;
            if (httpResp && httpResp.statusCode == 200) {
                [self.webView loadRequest:req];
            } else if (attempts > 1) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.35 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                    [self loadAppWithRetry:attempts - 1];
                });
            } else {
                [self.webView loadRequest:req];
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

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
    NSAlert *alert = [[NSAlert alloc] init];
    [alert setMessageText:@"Vanaras"];
    [alert setInformativeText:message];
    [alert addButtonWithTitle:@"OK"];
    [alert addButtonWithTitle:@"Cancel"];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse returnCode) {
        completionHandler(returnCode == NSAlertFirstButtonReturn);
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

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    [self reloadWebView:nil];
    if (self.window) {
        [self.window makeKeyAndOrderFront:nil];
    }
    return YES;
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
