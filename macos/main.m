#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface AppDelegate : NSObject <NSApplicationDelegate, WKUIDelegate>
@property (strong, nonatomic) NSWindow *window;
@property (strong, nonatomic) WKWebView *webView;
@property (strong, nonatomic) NSTask *serverTask;
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [self setupMainMenu];
    [self ensureBackendServerRunning];

    NSRect frame = NSMakeRect(0, 0, 1440, 880);
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
    [self.window setTitle:@"Vanaras Pro — Multi-Agent Engineering Workbench"];
    [self.window setTitleVisibility:NSWindowTitleHidden];
    [self.window setTitlebarAppearsTransparent:YES];
    [self.window setBackgroundColor:[NSColor colorWithSRGBRed:0.95 green:0.96 blue:0.97 alpha:1.0]];

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
    [self ensureBackendServerRunning];
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

- (NSString *)resolveVanarasRepoDir {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *bundlePath = [[NSBundle mainBundle] bundlePath];
    NSString *adjacentDir = [bundlePath stringByDeletingLastPathComponent];
    if ([fm fileExistsAtPath:[adjacentDir stringByAppendingPathComponent:@"ui/server.mjs"]]) {
        return adjacentDir;
    }
#ifdef VANARAS_REPO_ROOT
    NSString *compiledRoot = [NSString stringWithUTF8String:VANARAS_REPO_ROOT];
    if ([fm fileExistsAtPath:[compiledRoot stringByAppendingPathComponent:@"ui/server.mjs"]]) {
        return compiledRoot;
    }
#endif
    return adjacentDir;
}

- (NSString *)resolveNodeExecutable:(NSMutableArray<NSString *> *)extraPathDirs {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *home = NSHomeDirectory();
    NSMutableArray<NSString *> *candidates = [NSMutableArray array];

    NSString *nvmVersionsDir = [home stringByAppendingPathComponent:@".nvm/versions/node"];
    NSArray<NSString *> *nvmEntries = [fm contentsOfDirectoryAtPath:nvmVersionsDir error:nil];
    if (nvmEntries.count > 0) {
        NSArray<NSString *> *sorted = [nvmEntries sortedArrayUsingSelector:@selector(localizedStandardCompare:)];
        for (NSString *ver in [sorted reverseObjectEnumerator]) {
            NSString *binDir = [[nvmVersionsDir stringByAppendingPathComponent:ver] stringByAppendingPathComponent:@"bin"];
            [extraPathDirs addObject:binDir];
            [candidates addObject:[binDir stringByAppendingPathComponent:@"node"]];
        }
    }

    [extraPathDirs addObjectsFromArray:@[
        @"/opt/homebrew/bin",
        @"/usr/local/bin",
        [home stringByAppendingPathComponent:@".cargo/bin"],
        [home stringByAppendingPathComponent:@".local/bin"],
        @"/usr/bin",
        @"/bin",
        @"/usr/sbin",
        @"/sbin"
    ]];

    [candidates addObjectsFromArray:@[
        @"/opt/homebrew/bin/node",
        @"/usr/local/bin/node",
        @"/usr/bin/node"
    ]];

    for (NSString *candidate in candidates) {
        if ([fm isExecutableFileAtPath:candidate]) {
            return candidate;
        }
    }
    return nil;
}

- (void)ensureBackendServerRunning {
    if (self.serverTask && [self.serverTask isRunning]) {
        return;
    }
    NSURL *healthUrl = [NSURL URLWithString:@"http://127.0.0.1:3000/api/health"];
    NSURLRequest *req = [NSURLRequest requestWithURL:healthUrl
                                         cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                     timeoutInterval:0.45];
    __weak typeof(self) weakSelf = self;
    NSURLSessionDataTask *probe = [[NSURLSession sharedSession] dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        NSHTTPURLResponse *httpResp = (NSHTTPURLResponse *)response;
        if (httpResp && httpResp.statusCode == 200) {
            return; // Server is already running and healthy on port 3000
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            __strong typeof(weakSelf) strongSelf = weakSelf;
            if (strongSelf) {
                [strongSelf launchBackendServerNow];
            }
        });
    }];
    [probe resume];
}

- (void)launchBackendServerNow {
    if (self.serverTask && [self.serverTask isRunning]) {
        return;
    }
    NSString *vanarasDir = [self resolveVanarasRepoDir];
    NSString *serverScript = [vanarasDir stringByAppendingPathComponent:@"ui/server.mjs"];
    if (![[NSFileManager defaultManager] fileExistsAtPath:serverScript]) {
        return;
    }

    NSMutableArray<NSString *> *pathDirs = [NSMutableArray array];
    NSString *nodeBin = [self resolveNodeExecutable:pathDirs];
    if (!nodeBin) return;

    NSMutableDictionary<NSString *, NSString *> *env = [NSMutableDictionary dictionaryWithDictionary:[[NSProcessInfo processInfo] environment]];
    NSString *existingPath = env[@"PATH"] ?: @"/usr/bin:/bin:/usr/sbin:/sbin";
    NSString *joinedPaths = [[pathDirs valueForKey:@"description"] componentsJoinedByString:@":"];
    env[@"PATH"] = [NSString stringWithFormat:@"%@:%@", joinedPaths, existingPath];

    NSTask *task = [[NSTask alloc] init];
    [task setExecutableURL:[NSURL fileURLWithPath:nodeBin]];
    [task setArguments:@[serverScript]];
    [task setCurrentDirectoryURL:[NSURL fileURLWithPath:vanarasDir]];
    [task setEnvironment:env];
    __weak typeof(self) weakSelf = self;
    [task setTerminationHandler:^(NSTask *terminatedTask) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            __strong typeof(weakSelf) strongSelf = weakSelf;
            if (strongSelf) {
                strongSelf.serverTask = nil;
                [strongSelf ensureBackendServerRunning];
            }
        });
    }];
    self.serverTask = task;
    @try {
        [self.serverTask launchAndReturnError:nil];
    } @catch (NSException *exception) {
        self.serverTask = nil;
    }
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    if (self.serverTask) {
        [self.serverTask setTerminationHandler:nil];
        if ([self.serverTask isRunning]) {
            [self.serverTask terminate];
        }
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
