#import <ReplayKit/ReplayKit.h>

/// Finishes a broadcast without triggering the “error” alert.
/// (RPBroadcastSampleHandler’s parameter is formally non-null, so we suppress
///  the compiler warning.)
/// Refer to https://mehmetbaykar.com/posts/how-to-gracefully-stop-a-broadcast-upload-extension/
void finishBroadcastGracefully(RPBroadcastSampleHandler * _Nonnull handler);