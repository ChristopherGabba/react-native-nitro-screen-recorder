#import "BroadcastHelper.h"

void finishBroadcastGracefully(RPBroadcastSampleHandler * _Nonnull handler) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wnonnull"
    [handler finishBroadcastWithError:nil];   // ← the magic line ✨
#pragma clang diagnostic pop
}