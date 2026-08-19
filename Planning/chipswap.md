Chipswap

Normal Chip Size: 31x31px. Row sizes:
Row widths, top to bottom (31 rows)
9, 13, 17, 19, 21, 23, 25, 27, 27, 29, 29, 31, 31, 31, 31, 31, 31, 31, 31, 31, 29, 29, 27, 27, 25, 23, 21, 19, 17, 13, 9

General Idea:
Neutron app (an app installed on neutron canisters). Users download the app which allows them to create chips and trade them with other users.
Chip Editor:
    - Allows user to define colors on each pixel of a chip
    - Holds a pallette allowing users to easily swap between colors they've used or add colors to their pallette via a color picker
    - Blend colors on pallette to get an intermediate color
    - Control brush size (e.g. 1 px, 2x2px, custom shaped brushes defined as pixel grids....maybe L shape, X shape, whatever pattern brush the user wants to add)
    - Ability to lock pixels so they are no colored in by actions the user takes until unlocked
        - Unlock all option
        - Lock by brush
        - Lock all of color
    - Pattern generators - including those in cricle-bench_1.html, but others as well potentially
        - Cocentric rings
        - Spokes
        - Pixel Grid
    - Users can create 10 designs. Once a design is created, it is immutable. Designs may be saved in a draft state while they are being worked on (at which point they are still mutable and not publically visible).
    - Once a chip design is created, it is publically visible and locked for edits.

Chip Trading:
    - Chips are acquired by trading other users for their chips.
    - Users "mint" unlimited copies of their own chip designs. When another user trades for a chip you've desigend, your neutron canister creates an instance of your chip to give them in exchange for the chip they trade you.
    - Users may also trade chips they've acquired, but those do not create new chips and so trading a chip you've received from another user will mean you no longer own that chip and need to acquire it again.
    - Users can decide if their chip designs will automatically accept any other chip as a trade, or if they need to accept the trade before creating & sending a chip to the user proposing a trade.

Chip directory:
    - Chips keep a reference to their designer's neutron canister that allows holders of the chip to know about the designer's canister address to check for other chip designs.
    - When 2 users trade chips, they share their directories (IE they tell each other about all the designer canisters they know about). So by trading a chip, you get information about what other chips might be available. These designer canisters get tracked in your directory even if you don't hold chips from that designer.
    - When your neutron canister learns about a new designer's canister that you hadn't previously seen, you have the option of publishing yourself to that canister's directory. This way all chipswap canisters have a way of staying up to date with what's available, even as new users come into the system.
    
Chip store:
    - Users may view chips available to trade for by opening up their chip store. This queries the chip designer canisters listed in their directory to see what chips are available to trade.
    - Users may filter chips in the store by a variety of filters
        - By ownership - All, Chips I Own, Chips I don't own
        - By designer ownership - All, Designers who I own a chip of theirs, Designers who i don't own a chip of theirs
        - By trade mode - All, Only Chips that automatically accept trades, Only Chips that require designer 

Future looking improvements:
    The following are features for potentially addition in the future. They should not be implemented at this moment, but the system design should not be such that it will prevent these features from being added at a later time.
    - Additional chip design credits - users may be able to purchase credits to extend their 10 design limit
    - Additional chip sizes - initial and normal chips will be 31px diameter, but future features may allow creation of chips of varying sizes
    - Additional chip shapes - initial and normal chips will be circular (according to the row size definition above), but future chips may have more variable shapes (e.g. square, triangle, star, hexagon, etc)
    - Additional design pattern generators