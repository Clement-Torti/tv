function addTvLink() {
    // 1. Check if our link already exists to prevent duplicates
    if (document.getElementById('clement-tv-link')) return;

    // 2. Find the main navigation list (ul)
    // Netflix uses the class 'tabbed-primary-navigation' for the left-side menu
    const navList = document.querySelector('ul.tabbed-primary-navigation');

    if (navList) {
        // 3. Create the List Item (li)
        const li = document.createElement('li');
        li.className = 'navigation-tab'; // Netflix standard class
        li.id = 'clement-tv-link';
        li.style.marginLeft = '20px'; // Add a little spacing

        // 4. Create the Link (a)
        const a = document.createElement('a');
        a.href = 'https://clement-torti.github.io/tv/';
        a.innerText = 'TV';
        
        // 5. Apply Netflix-like Styles
        // We use inline styles to match the unselected state colors
        a.style.textDecoration = 'none';
        a.style.color = '#e5e5e5'; 
        a.style.fontSize = '14px';
        a.style.transition = 'color 0.4s';
        
        // Add hover effect logic
        a.onmouseover = function() { this.style.color = '#b3b3b3'; };
        a.onmouseout = function() { this.style.color = '#e5e5e5'; };

        // 6. Append to the DOM
        li.appendChild(a);
        navList.appendChild(li);
    }
}

// 7. Run the function repeatedly
// Netflix is a "Single Page Application" (SPA), so the navigation bar might 
// disappear/reappear when you scroll or change pages. 
// We check every second to ensure the button stays there.
setInterval(addTvLink, 1000);

// Run immediately once just in case
addTvLink();